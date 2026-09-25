// 每个舞台（聊天）一份的运行态：回合、面板、沙龙、私语。存 chat_metadata['persona-arena']。

import { MODULE_NAME, getSettings, normalizeActor, uid } from './settings.js';

export const LIMITS = Object.freeze({
    rounds: 30,
    chronicle: 40,
    salon: 200,
    whisper: 120,
    bonds: 24,
    abilities: 16,
    npcs: 30,
    chronicleLog: 20,
    compassHistory: 6,
    overlayChars: 600,
});

function ctx() { return SillyTavern.getContext(); }

function emptyState() {
    return {
        version: 1,
        rounds: [],
        actorState: {},
        salon: [],
        whispers: {},
        lastLore: null,
        plot: emptyPlot(),
        chronicleLog: [],
        npcs: [],
        chroniclerLastFloor: -1,
    };
}

function emptyPlot() {
    return {
        canonId: '',
        loreBook: '',
        loreUids: [],
        notes: '',
        compass: null,
        compassAt: null,
        compassFloor: -1,
        history: [],
        guidanceOverride: '',
        actOverride: -1,   // -1 = 让模型自动判断当前幕；>=0 = 导演手动指定的幕序号
        located: null,     // { canonId, actIndex, title, reason, confidence, pointHint, actsCount, at, floor }
    };
}

export function getState() {
    const { chatMetadata } = ctx();
    if (!chatMetadata) return emptyState();
    if (!chatMetadata[MODULE_NAME] || typeof chatMetadata[MODULE_NAME] !== 'object') {
        chatMetadata[MODULE_NAME] = emptyState();
    }
    const st = chatMetadata[MODULE_NAME];
    st.rounds ??= [];
    st.actorState ??= {};
    st.salon ??= [];
    st.whispers ??= {};
    if (!st.plot || typeof st.plot !== 'object') st.plot = emptyPlot();
    else for (const [k, v] of Object.entries(emptyPlot())) if (!(k in st.plot)) st.plot[k] = v;
    st.chronicleLog ??= [];
    st.npcs ??= [];
    st.chroniclerLastFloor ??= -1;
    if (!Array.isArray(st.actors)) {
        // 迁移：老版本演员是全局的；这个聊天里有过面板记录的演员，从演员库复制进来
        st.actors = [];
        const lib = getSettings().actors || [];
        for (const id of Object.keys(st.actorState || {})) {
            const a = lib.find(x => x.id === id);
            if (a) st.actors.push(normalizeActor(structuredClone(a)));
        }
        if (st.actors.length) saveState();
    }
    return st;
}

export function hasOpenChat() {
    const c = ctx();
    return !!(c.chatId || c.groupId);
}

// ---------- 本聊天的演员 ----------

export function chatActors() {
    return getState().actors;
}

export function getActor(id) {
    return chatActors().find(a => a.id === id) || null;
}

export function upsertActor(actor) {
    const list = chatActors();
    if (!actor.id) actor.id = uid('actor');
    const idx = list.findIndex(a => a.id === actor.id);
    if (idx >= 0) list[idx] = actor; else list.push(actor);
    saveState();
    return actor;
}

export function removeActor(id) {
    const st = getState();
    st.actors = st.actors.filter(a => a.id !== id);
    saveState();
}

export function moveActor(id, delta) {
    const list = chatActors();
    const idx = list.findIndex(a => a.id === id);
    const target = idx + delta;
    if (idx < 0 || target < 0 || target >= list.length) return;
    const [a] = list.splice(idx, 1);
    list.splice(target, 0, a);
    saveState();
}

/** 从演员库邀请一位演员到本聊天（复制一份；已在场则返回 null）。 */
export function inviteFromLibrary(libraryId) {
    const lib = (getSettings().actors || []).find(a => a.id === libraryId);
    if (!lib) return null;
    const list = chatActors();
    if (list.some(a => a.id === lib.id)) return null;
    const copy = normalizeActor(structuredClone(lib));
    copy.libraryId = lib.id;
    list.push(copy);
    saveState();
    return copy;
}

export function getPlot() {
    return getState().plot;
}

let saveTimer = null;
export function saveState() {
    const c = ctx();
    if (typeof c.saveMetadataDebounced === 'function') {
        c.saveMetadataDebounced();
        return;
    }
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => c.saveMetadata?.(), 800);
}

export function resetState() {
    const { chatMetadata } = ctx();
    if (chatMetadata) chatMetadata[MODULE_NAME] = emptyState();
    saveState();
}

export function getActorState(actorId) {
    const st = getState();
    if (!st.actorState[actorId]) {
        st.actorState[actorId] = {
            mood: '',
            goal: '',
            bonds: [],
            chronicle: [],
            pendingInstruction: null,
            lastMove: '',
            abilities: [],
            overlay: {},
        };
    }
    const a = st.actorState[actorId];
    a.bonds ??= [];
    a.chronicle ??= [];
    a.abilities ??= [];
    a.overlay ??= {};
    return a;
}

const OVERLAY_FIELDS = ['personality', 'appearance', 'backstory', 'voice', 'bottomLines', 'goals'];

/** 把史官给出的"本剧中的变化"追加到该演员的覆盖层（不改全局人设卡）。 */
export function appendOverlay(actorId, field, text) {
    if (!OVERLAY_FIELDS.includes(field)) return;
    const t = String(text || '').trim();
    if (!t) return;
    const a = getActorState(actorId);
    const cur = String(a.overlay[field] || '');
    if (cur.includes(t)) return;
    let next = cur ? `${cur}；${t}` : t;
    if (next.length > LIMITS.overlayChars) next = next.slice(next.length - LIMITS.overlayChars);
    a.overlay[field] = next;
}

export function applyAbilityUpdate(actorId, upd) {
    if (!upd || typeof upd !== 'object') return;
    const a = getActorState(actorId);
    const norm = (x) => (typeof x === 'string' ? { name: x, note: '' } : { name: String(x?.name || '').trim(), note: String(x?.note || '').trim().slice(0, 80) });
    for (const g of (Array.isArray(upd.gained) ? upd.gained : [])) {
        const n = norm(g); if (!n.name) continue;
        const ex = a.abilities.find(x => x.name === n.name);
        if (ex) { if (n.note) ex.note = n.note; continue; }
        if (a.abilities.length >= LIMITS.abilities) continue;
        a.abilities.push({ name: n.name.slice(0, 24), note: n.note });
    }
    for (const c of (Array.isArray(upd.changed) ? upd.changed : [])) {
        const n = norm(c); if (!n.name) continue;
        const ex = a.abilities.find(x => x.name === n.name);
        if (ex) ex.note = n.note || ex.note; else if (a.abilities.length < LIMITS.abilities) a.abilities.push({ name: n.name.slice(0, 24), note: n.note });
    }
    for (const l of (Array.isArray(upd.lost) ? upd.lost : [])) {
        const name = typeof l === 'string' ? l : l?.name;
        if (!name) continue;
        a.abilities = a.abilities.filter(x => x.name !== name);
    }
}

/** 快照/恢复全部演员面板（史官撤销用）。 */
export function snapshotActorStates() {
    const st = getState();
    return structuredClone({ actorState: st.actorState, npcs: st.npcs });
}

export function restoreActorStates(snap) {
    if (!snap) return;
    const st = getState();
    st.actorState = structuredClone(snap.actorState || {});
    st.npcs = structuredClone(snap.npcs || []);
    saveState();
}

export function pushChronicleLog(entry) {
    const st = getState();
    st.chronicleLog.push(entry);
    if (st.chronicleLog.length > LIMITS.chronicleLog) st.chronicleLog.splice(0, st.chronicleLog.length - LIMITS.chronicleLog);
    return entry;
}

export function upsertNpc(npc) {
    const st = getState();
    const name = String(npc?.name || '').trim();
    if (!name) return;
    let ex = st.npcs.find(n => n.name === name);
    if (!ex) {
        if (st.npcs.length >= LIMITS.npcs) return;
        ex = { name, role: '', note: '' };
        st.npcs.push(ex);
    }
    if (npc.role) ex.role = String(npc.role).slice(0, 40);
    if (npc.note) ex.note = String(npc.note).slice(0, 160);
}

export function clampBond(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return 0;
    return Math.max(-100, Math.min(100, Math.round(n)));
}

/** 应用演员自己产出的 state 更新（宽松、尽力而为）。 */
export function applyStateUpdate(actorId, update, roundIndex) {
    if (!update || typeof update !== 'object') return;
    const a = getActorState(actorId);
    if (typeof update.mood === 'string' && update.mood.trim()) a.mood = update.mood.trim().slice(0, 60);
    if (typeof update.goal === 'string' && update.goal.trim()) a.goal = update.goal.trim().slice(0, 120);
    if (typeof update.memory === 'string' && update.memory.trim()) {
        a.chronicle.push({ round: roundIndex ?? null, ts: Date.now(), text: update.memory.trim().slice(0, 200) });
        if (a.chronicle.length > LIMITS.chronicle) a.chronicle.splice(0, a.chronicle.length - LIMITS.chronicle);
    }
    const bonds = Array.isArray(update.bonds) ? update.bonds : [];
    for (const b of bonds) {
        if (!b || typeof b !== 'object') continue;
        const target = String(b.target || b.name || '').trim();
        if (!target) continue;
        let existing = a.bonds.find(x => x.target === target);
        if (!existing) {
            if (a.bonds.length >= LIMITS.bonds) continue;
            existing = { target, score: 0, label: '', note: '' };
            a.bonds.push(existing);
        }
        if (b.delta !== undefined) existing.score = clampBond(existing.score + Number(b.delta || 0));
        if (b.score !== undefined) existing.score = clampBond(b.score);
        if (typeof b.label === 'string' && b.label.trim()) existing.label = b.label.trim().slice(0, 24);
        if (typeof b.note === 'string' && b.note.trim()) existing.note = b.note.trim().slice(0, 120);
    }
}

export function pushRound(round) {
    const st = getState();
    st.rounds.push(round);
    if (st.rounds.length > LIMITS.rounds) st.rounds.splice(0, st.rounds.length - LIMITS.rounds);
    return round;
}

export function currentRound() {
    const st = getState();
    return st.rounds[st.rounds.length - 1] || null;
}

export function pushSalon(msg) {
    const st = getState();
    st.salon.push(msg);
    if (st.salon.length > LIMITS.salon) st.salon.splice(0, st.salon.length - LIMITS.salon);
    return msg;
}

export function getWhisper(actorId) {
    const st = getState();
    if (!Array.isArray(st.whispers[actorId])) st.whispers[actorId] = [];
    return st.whispers[actorId];
}

export function pushWhisper(actorId, msg) {
    const list = getWhisper(actorId);
    list.push(msg);
    if (list.length > LIMITS.whisper) list.splice(0, list.length - LIMITS.whisper);
    return msg;
}

/** 本聊天里所有启用的演员，按顺序。 */
export function activeActors() {
    return chatActors().filter(a => a.enabled && a.name);
}
