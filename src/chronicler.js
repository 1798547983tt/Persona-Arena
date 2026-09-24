// 史官：正文每出一楼，让指定的"主 AI"核对并更新每位演员的面板、羁绊、能力与人设变化。

import { getSettings, saveSettings, getConnection, getActor, uid } from './settings.js';
import { getState, saveState, activeActors, getActorState, applyStateUpdate, applyAbilityUpdate, appendOverlay, snapshotActorStates, restoreActorStates, pushChronicleLog, upsertNpc } from './state.js';
import { resolveConnection, sendChat } from './connections.js';
import { buildChroniclerMessages } from './prompts.js';
import { describeError, requestJson } from './llm.js';
import { plotFeedForActors } from './plot.js';

const listeners = new Set();
let busy = false;
let timer = null;
let controller = null;

function ctx() { return SillyTavern.getContext(); }
export function onChroniclerChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit(detail = {}) { for (const fn of listeners) { try { fn(detail); } catch (e) { console.warn(e); } } }
export function chroniclerBusy() { return busy; }
export function abortChronicler() { controller?.abort(); }

export function chroniclerConnection() {
    const s = getSettings();
    return getConnection(s.chronicler.connectionId) || getConnection(s.workshopConnectionId) || resolveConnection();
}

function floorText(m) {
    const t = Array.isArray(m?.swipes) && m.swipes.length && Number.isInteger(m.swipe_id) ? (m.swipes[m.swipe_id] ?? m.mes) : m?.mes;
    return String(t || '').trim();
}

function findActorByName(actors, name) {
    const n = String(name || '').trim();
    if (!n) return null;
    return actors.find(a => a.name === n) || actors.find(a => n.includes(a.name) || a.name.includes(n)) || null;
}

/** 事件入口：新楼渲染后延迟 1.2 秒再记（避免连续触发）。 */
export function scheduleRecord(messageId, { isUser = false } = {}) {
    const s = getSettings();
    if (!s.chronicler.enabled) return;
    if (s.chronicler.trigger === 'manual') return;
    if (isUser && s.chronicler.trigger !== 'all') return;
    clearTimeout(timer);
    timer = setTimeout(() => { recordFloor({ messageId }).catch(err => console.warn('[PersonaArena] chronicler failed', err)); }, 1200);
}

/**
 * 记一笔：读取 chat[messageId]（默认最后一楼），让史官输出更新，应用到面板。
 * 返回日志条目；无变化返回 null。
 */
export async function recordFloor({ messageId, manual = false, onProgress } = {}) {
    if (busy) throw new Error('史官正在记录');
    const s = getSettings();
    const c = ctx();
    const chat = c.chat || [];
    let idx = Number.isInteger(messageId) ? messageId : chat.length - 1;
    while (idx >= 0 && (chat[idx]?.is_system || !floorText(chat[idx]))) idx--;
    const msg = chat[idx];
    if (!msg) throw new Error('舞台上还没有可记录的楼层');
    const text = floorText(msg);
    if (!manual && text.length < (Number(s.chronicler.minChars) || 0)) return null;
    const st = getState();
    if (!manual && st.chroniclerLastFloor === idx && st.chronicleLog.some(l => l.floor === idx)) return null;
    const actors = activeActors();
    if (!actors.length) return null;
    const chatId = c.chatId;
    busy = true;
    controller = new AbortController();
    emit({ started: true });
    try {
        onProgress?.('史官正在核对…');
        const prior = [];
        for (let i = idx - 1, n = 0; i >= 0 && n < 2; i--) {
            if (chat[i]?.is_system) continue;
            const t = floorText(chat[i]); if (!t) continue;
            prior.unshift({ name: chat[i].name, text: t.slice(0, 900) }); n++;
        }
        const messages = buildChroniclerMessages({
            actors: actors.map(a => ({ actor: a, state: getActorState(a.id) })),
            npcs: st.npcs, floor: { name: msg.name, text: text.slice(0, 6000) }, prior,
            fields: s.chronicler.fields, plotBeats: plotFeedForActors(),
        });
        const conn = { ...chroniclerConnection(), stream: false };
        const sig = controller.signal;
        const send = (msgs) => sendChat(conn, msgs, { maxTokens: 1800, temperature: 0.3, signal: sig, task: 'tool' });
        const json = await requestJson(send, messages, { keys: ['summary', 'actors'], label: '史官 JSON' });
        if (!json || typeof json !== 'object') throw new Error('史官没有返回可解析的 JSON');
        if (ctx().chatId !== chatId) throw new Error('聊天已切换，本次记录作废');
        const snapshot = snapshotActorStates();
        const changes = [];
        const f = s.chronicler.fields || {};
        for (const u of (Array.isArray(json.actors) ? json.actors : [])) {
            const actor = findActorByName(actors, u?.name);
            if (!actor) continue;
            const before = structuredClone(getActorState(actor.id));
            const upd = {};
            if (f.mood && u.mood) upd.mood = u.mood;
            if (f.goal && u.goal) upd.goal = u.goal;
            if (f.chronicle && u.memory) upd.memory = u.memory;
            if (f.bonds && Array.isArray(u.bonds)) upd.bonds = u.bonds;
            applyStateUpdate(actor.id, upd, null);
            if (f.abilities && u.abilities) applyAbilityUpdate(actor.id, u.abilities);
            if (f.sheet && u.sheet && typeof u.sheet === 'object') {
                for (const [k, v] of Object.entries(u.sheet)) appendOverlay(actor.id, k, v);
            }
            const after = getActorState(actor.id);
            const diff = [];
            if (before.mood !== after.mood) diff.push(`心情 → ${after.mood}`);
            if (before.goal !== after.goal) diff.push(`目标 → ${after.goal}`);
            for (const b of after.bonds) {
                const ob = before.bonds.find(x => x.target === b.target);
                if (!ob) diff.push(`新关系 ${b.target} ${b.score >= 0 ? '+' : ''}${b.score}`);
                else if (ob.score !== b.score) diff.push(`${b.target} ${ob.score} → ${b.score}`);
            }
            const abBefore = new Set(before.abilities.map(x => x.name)), abAfter = new Set(after.abilities.map(x => x.name));
            for (const n of abAfter) if (!abBefore.has(n)) diff.push(`获得能力「${n}」`);
            for (const n of abBefore) if (!abAfter.has(n)) diff.push(`失去能力「${n}」`);
            for (const [k, v] of Object.entries(after.overlay || {})) if ((before.overlay || {})[k] !== v) diff.push(`人设·${k} 有新变化`);
            if (after.chronicle.length > before.chronicle.length) diff.push('经历簿 +1');
            if (diff.length) changes.push({ actorId: actor.id, name: actor.name, diff });
        }
        if (f.npcs && Array.isArray(json.npcs)) for (const n of json.npcs) upsertNpc(n);
        st.chroniclerLastFloor = idx;
        const entry = pushChronicleLog({
            id: uid('log'), ts: Date.now(), floor: idx, floorName: msg.name,
            summary: String(json.summary || '').slice(0, 200), changes, snapshot,
        });
        // 只给最近 3 条留快照
        for (let i = 0; i < st.chronicleLog.length - 3; i++) delete st.chronicleLog[i].snapshot;
        saveState();
        emit({ entry });
        return entry;
    } catch (err) {
        emit({ error: describeError(err) });
        throw err;
    } finally {
        busy = false;
        controller = null;
        emit({ finished: true });
    }
}

/** 撤销最近一次记录（恢复快照）。 */
export function undoLast() {
    const st = getState();
    const last = st.chronicleLog[st.chronicleLog.length - 1];
    if (!last?.snapshot) throw new Error('没有可撤销的记录');
    restoreActorStates(last.snapshot);
    st.chronicleLog.pop();
    st.chroniclerLastFloor = st.chronicleLog[st.chronicleLog.length - 1]?.floor ?? -1;
    saveState();
    emit({ undone: last });
    return last;
}

/** 把演员在本剧中的变化固化进全局人设卡（之后所有聊天可见）。 */
export function solidifyOverlay(actorId) {
    const actor = getActor(actorId);
    const st = getActorState(actorId);
    if (!actor) throw new Error('找不到演员');
    const o = st.overlay || {};
    let n = 0;
    for (const [k, v] of Object.entries(o)) {
        if (!String(v || '').trim()) continue;
        const base = String(actor.sheet[k] || '').trim();
        actor.sheet[k] = base ? `${base}\n（后来）${v}` : String(v);
        n++;
    }
    if (st.abilities?.length) {
        const base = String(actor.sheet.abilities || '').trim();
        const add = st.abilities.map(a => a.note ? `${a.name}（${a.note}）` : a.name).join('\n');
        actor.sheet.abilities = base ? `${base}\n${add}` : add;
        st.abilities = [];
        n++;
    }
    st.overlay = {};
    saveSettings();
    saveState();
    emit({ solidified: actorId });
    return n;
}

export function clearOverlay(actorId) {
    const st = getActorState(actorId);
    st.overlay = {};
    saveState();
    emit({});
}
