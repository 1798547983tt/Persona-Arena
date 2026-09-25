// 剧情罗盘：原著（世界书条目 / TXT 小说 / 手写梗概）→ 摘要 → 走向推演 → 注入正文提示词。

import { getSettings, getCanon, upsertCanon, uid, getConnection } from './settings.js';
import { getState, getPlot, saveState, LIMITS, activeActors, getActorState } from './state.js';
import { resolveConnection, sendChat } from './connections.js';
import { collectStage } from './stage.js';
import { buildCompassMessages } from './prompts.js';
import { describeError, requestJson } from './llm.js';
import {
    buildCanonFromText, buildCanonFromKnowledge, structureActs, deleteCanon as destroyCanon,
    loadCanonDetail, locateAct, canonPositionText,
} from './canon.js';

export { splitChunks, loadCanonDetail, saveCanonDetail, exportCanon, importCanon, actsBrief } from './canon.js';

const INJECT_KEY = 'PERSONA_ARENA_PLOT';
const listeners = new Set();
let busy = '';           // '' | 'summarize' | 'compass'
let controller = null;

function ctx() { return SillyTavern.getContext(); }

export function onPlotChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit(detail = {}) { for (const fn of listeners) { try { fn(detail); } catch (e) { console.warn(e); } } }
export function plotBusy() { return busy; }
export function abortPlot() { controller?.abort(); }

export function plotConnection() {
    const s = getSettings();
    return getConnection(s.plot.connectionId) || getConnection(s.workshopConnectionId) || resolveConnection();
}

// ---------- 原著来源 ----------

function ctxHeaders() {
    try { return ctx().getRequestHeaders(); } catch { return { 'Content-Type': 'application/json' }; }
}

let cachedNames = [];

/** 世界书名字：优先上下文接口，其次酒馆编辑器下拉框，最后直接问服务器。 */
export async function refreshLoreBooks() {
    const c = ctx();
    let names = [];
    try { if (typeof c.updateWorldInfoList === 'function') await c.updateWorldInfoList(); } catch { /* 忽略 */ }
    try { if (typeof c.getWorldInfoNames === 'function') names = c.getWorldInfoNames() || []; } catch { names = []; }
    if (!names.length) {
        names = [...document.querySelectorAll('#world_editor_select option, #world_info option')]
            .map(o => String(o.textContent || '').trim())
            .filter(t => t && !/^-{2,}/.test(t) && !/pick to edit/i.test(t));
    }
    if (!names.length) {
        try {
            const res = await fetch('/api/settings/get', { method: 'POST', headers: ctxHeaders(), body: '{}' });
            if (res.ok) { const data = await res.json(); names = Array.isArray(data?.world_names) ? data.world_names : []; }
        } catch { /* 忽略 */ }
    }
    cachedNames = [...new Set(names.map(String))];
    return listLoreBooks();
}

export function listLoreBooks() {
    const c = ctx();
    let names = cachedNames;
    if (!names.length) {
        try { if (typeof c.getWorldInfoNames === 'function') names = c.getWorldInfoNames() || []; } catch { names = []; }
        if (!names.length) {
            names = [...document.querySelectorAll('#world_editor_select option, #world_info option')]
                .map(o => String(o.textContent || '').trim())
                .filter(t => t && !/^-{2,}/.test(t) && !/pick to edit/i.test(t));
        }
        names = [...new Set(names.map(String))];
    }
    const ch = (c.characterId !== undefined && c.characterId !== null) ? c.characters?.[c.characterId] : null;
    const charBook = ch?.data?.extensions?.world || '';
    const chatBook = c.chatMetadata?.world_info || '';
    return names.map(n => ({ name: n, bound: n === charBook ? '角色' : n === chatBook ? '聊天' : '' }))
        .sort((a, b) => (b.bound ? 1 : 0) - (a.bound ? 1 : 0));
}

async function fetchWorldInfo(book) {
    const c = ctx();
    let data = null;
    try { if (typeof c.loadWorldInfo === 'function') data = await c.loadWorldInfo(book); } catch { data = null; }
    if (!data) {
        const res = await fetch('/api/worldinfo/get', { method: 'POST', headers: ctxHeaders(), body: JSON.stringify({ name: book }) });
        if (!res.ok) throw new Error(`读取世界书失败（${res.status}）`);
        data = await res.json();
    }
    return data;
}

export async function loadLoreEntries(book) {
    if (!book) return [];
    const data = await fetchWorldInfo(book);
    const raw = data?.entries;
    const entries = Array.isArray(raw) ? raw : (raw && typeof raw === 'object' ? Object.values(raw) : []);
    return entries
        .map((e, i) => ({
            uid: Number.isFinite(Number(e.uid)) ? Number(e.uid) : i,
            comment: String(e.comment || '').trim(), key: Array.isArray(e.key) ? e.key : (typeof e.key === 'string' ? e.key.split(',').map(x => x.trim()).filter(Boolean) : []),
            content: String(e.content || ''), disable: !!e.disable, constant: !!e.constant, order: Number(e.order ?? 100),
        }))
        .filter(e => e.content.trim())
        .sort((a, b) => (a.order - b.order) || (a.uid - b.uid));
}

/** 忙碌保护 + 中止控制，包住耗时的原著任务。 */
async function guarded(kind, fn, signal) {
    if (busy) throw new Error('剧情模块正忙');
    busy = kind;
    controller = new AbortController();
    const sig = signal || controller.signal;
    try {
        const result = await fn(sig);
        emit(result?.id ? { canon: result } : {});
        return result;
    } finally {
        busy = '';
        controller = null;
        emit({});
    }
}

/** 长文本（TXT / 世界书拼接）→ 幕与剧情点 → 概览。返回原著索引。 */
export function summarizeText({ name, text, sourceType = 'txt', onProgress, signal }) {
    return guarded('summarize', (sig) => buildCanonFromText({ name, text, sourceType, onProgress, signal: sig }), signal);
}

/** 从世界书条目建原著：短则直接用原文，长则走分幕总结。 */
export async function canonFromLore({ book, uids, name, onProgress, signal }) {
    const entries = (await loadLoreEntries(book)).filter(e => uids.includes(e.uid));
    if (!entries.length) throw new Error('没有选中任何条目');
    const text = entries.map(e => `【${e.comment || e.key.join('/') || '条目'}】\n${e.content.trim()}`).join('\n\n');
    const s = getSettings();
    if (text.length <= (Number(s.plot.digestMaxChars) || 5000) * 1.2) {
        const canon = upsertCanon({ id: uid('canon'), name: name || book, sourceType: 'lore', digest: text, chapters: [], chars: text.length, chunks: 1, createdAt: Date.now(), loreBook: book, loreUids: uids });
        emit({ canon });
        return canon;
    }
    const canon = await summarizeText({ name: name || book, text, sourceType: 'lore', onProgress, signal });
    canon.loreBook = book; canon.loreUids = uids; upsertCanon(canon);
    return canon;
}

/** 同人：按作品名，联网搜索（可选）后凭模型知识写概览与幕目。 */
export function canonFromKnowledge({ name, hints, useSearch, onProgress, signal }) {
    return guarded('summarize', (sig) => buildCanonFromKnowledge({ name, hints, useSearch, onProgress, signal: sig }), signal);
}

/** 只有梗概没有幕目的原著（手写 / 世界书短文 / 旧版）：自动分幕。 */
export function structureCanon({ canonId, onProgress, signal }) {
    const canon = getCanon(canonId);
    if (!canon) throw new Error('原著不存在');
    return guarded('summarize', async (sig) => { await structureActs({ canon, onProgress, signal: sig }); return canon; }, signal);
}

export function canonFromText({ name, digest }) {
    const canon = upsertCanon({ id: uid('canon'), name, sourceType: 'manual', digest: String(digest || '').trim(), chapters: [], chars: digest.length, chunks: 0, createdAt: Date.now() });
    emit({ canon });
    return canon;
}

export async function deleteCanon(id) {
    await destroyCanon(id);
    const st = getState();
    if (st.plot.canonId === id) { st.plot.canonId = ''; st.plot.located = null; st.plot.actOverride = -1; saveState(); }
    emit({});
}

export function readFileAsText(file) {
    return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result || ''));
        r.onerror = () => reject(new Error('读取文件失败'));
        // 中文 TXT 常见 GBK：先按 UTF-8 读，出现大量替换字符再退回 GB18030
        r.readAsText(file, 'utf-8');
    }).then(async (text) => {
        const bad = (text.match(/�/g) || []).length;
        if (bad > Math.max(20, text.length / 500)) {
            try {
                const buf = await file.arrayBuffer();
                return new TextDecoder('gb18030').decode(buf);
            } catch { return text; }
        }
        return text;
    });
}

// ---------- 罗盘 ----------

function actorsBrief() {
    return activeActors().map(a => {
        const st = getActorState(a.id);
        return `- ${a.name}：${st.goal ? '目标「' + st.goal + '」' : ''}${st.mood ? '，心情「' + st.mood + '」' : ''}`;
    }).join('\n');
}

function normalizeCompass(obj) {
    if (!obj || typeof obj !== 'object') return null;
    const arr = (v) => Array.isArray(v) ? v : (v ? [v] : []);
    const strs = (v) => arr(v).map(x => typeof x === 'string' ? x : (x?.what || x?.text || JSON.stringify(x))).filter(Boolean).slice(0, 8);
    const objs = (v, keys) => arr(v).map(x => (typeof x === 'string' ? { [keys[0]]: x } : (x || {}))).filter(x => Object.keys(x).length).slice(0, 8);
    return {
        now: String(obj.now || '').trim(),
        position: String(obj.position || '').trim(),
        inevitable: strs(obj.inevitable),
        deviated: objs(obj.deviated, ['what', 'cause', 'consequence']),
        impossible: strs(obj.impossible),
        possible: objs(obj.possible, ['what', 'chance', 'trigger']),
        butterflies: objs(obj.butterflies, ['origin', 'chain', 'outcome']).map(b => ({ ...b, chain: arr(b.chain).map(String) })),
        beats: strs(obj.beats).slice(0, 5),
        guidance: String(obj.guidance || '').trim(),
        canonAhead: objs(obj.canonAhead ?? obj.canon_ahead, ['event', 'status', 'why']),
        oocRisks: strs(obj.oocRisks ?? obj.ooc_risks),
    };
}

export function compassToText(compass, { brief = false } = {}) {
    if (!compass) return '';
    const L = [];
    if (compass.now) L.push(`当前局势：${compass.now}`);
    if (compass.position && !brief) L.push(`原著进度：${compass.position}`);
    if (compass.inevitable?.length) L.push(`必然会发生：\n${compass.inevitable.map(x => `- ${x}`).join('\n')}`);
    if (compass.deviated?.length && !brief) L.push(`已脱离原著：\n${compass.deviated.map(d => `- ${d.what || ''}${d.cause ? '（因：' + d.cause + '）' : ''}${d.consequence ? ' → ' + d.consequence : ''}`).join('\n')}`);
    if (compass.impossible?.length) L.push(`已不可能发生：\n${compass.impossible.map(x => `- ${x}`).join('\n')}`);
    if (compass.possible?.length && !brief) L.push(`可能发生：\n${compass.possible.map(p => `- ${p.what || ''}${p.chance ? '（' + p.chance + '）' : ''}${p.trigger ? '，触发：' + p.trigger : ''}`).join('\n')}`);
    if (compass.butterflies?.length && !brief) L.push(`蝴蝶效应：\n${compass.butterflies.map(b => `- ${b.origin || ''} → ${(b.chain || []).join(' → ')}${b.outcome ? ' ⇒ ' + b.outcome : ''}`).join('\n')}`);
    if (compass.canonAhead?.length) L.push(`原著接下来的事：\n${compass.canonAhead.map(e => `- ${e.event || ''}${e.status ? '【' + e.status + '】' : ''}${e.why ? '：' + e.why : ''}`).join('\n')}`);
    if (compass.oocRisks?.length && !brief) L.push(`OOC 提醒：\n${compass.oocRisks.map(x => `- ${x}`).join('\n')}`);
    if (compass.beats?.length) L.push(`接下来的节拍：\n${compass.beats.map((x, i) => `${i + 1}. ${x}`).join('\n')}`);
    if (compass.guidance) L.push(`引导：${compass.guidance}`);
    return L.join('\n\n');
}

/** 注入正文的文本（可被玩家改写的引导优先）。 */
export function injectionText() {
    const plot = getPlot();
    if (!plot.compass) return '';
    const c = { ...plot.compass };
    if (plot.guidanceOverride?.trim()) c.guidance = plot.guidanceOverride.trim();
    const body = compassToText(c, { brief: true });
    const ooc = plot.compass.oocRisks?.length ? `\n人物分寸（避免 OOC）：${plot.compass.oocRisks.slice(0, 4).join('；')}` : '';
    return `[剧情罗盘 · 导演给叙事者的走向指引]\n${body}${ooc}\n（说明：把"必然会发生"的事自然地推向发生，不要生硬点明；不要写"已不可能发生"的事；原著人物保持原著性格与说话方式；其余交给人物的选择。这是幕后指引，不要在正文里提及"罗盘"或"导演"。）`;
}

/** 给演员看的简版。 */
export function plotFeedForActors() {
    const s = getSettings();
    const plot = getPlot();
    if (!s.plot.feedActors || !plot.compass) return '';
    const c = plot.compass;
    const parts = [];
    if (c.now) parts.push(`当前局势：${c.now}`);
    if (c.beats?.length) parts.push(`接下来的节拍：${c.beats.join('；')}`);
    if (c.inevitable?.length) parts.push(`必然会发生：${c.inevitable.slice(0, 3).join('；')}`);
    return parts.join('\n');
}

export function applyInjection() {
    const c = ctx();
    if (typeof c.setExtensionPrompt !== 'function') return;
    const s = getSettings();
    const plot = getPlot();
    const text = (s.plot.injectEnabled && plot.compass && plot.injectEnabled !== false) ? injectionText() : '';
    const depth = Math.max(0, Number(s.plot.injectDepth) || 0);
    const role = Number(s.plot.injectRole) || 0;
    try { c.setExtensionPrompt(INJECT_KEY, text, 1 /* IN_CHAT */, depth, false, role); } catch (err) { console.warn('[PersonaArena] inject failed', err); }
}

/** 判断当前处于原著哪一幕（手动指定优先），把结果记在 plot.located 并返回给罗盘用的位置文本。 */
async function locateForCompass({ canon, plot, stage, sig, onProgress }) {
    const detail = await loadCanonDetail(canon.id);
    if (!detail?.acts?.length) return '';
    const override = Number(plot.actOverride);
    let located;
    if (Number.isInteger(override) && override >= 0 && override < detail.acts.length) {
        located = { actIndex: override, reason: '导演手动指定', confidence: '高', pointHint: '', manual: true };
    } else {
        onProgress?.('正在判断进行到原著哪一幕…');
        try {
            located = await locateAct({ canon, detail, stage, previous: plot.located && plot.located.canonId === canon.id ? plot.located : null, signal: sig });
        } catch (err) {
            console.warn('[PersonaArena] locate act failed', err);
            located = plot.located && plot.located.canonId === canon.id ? { ...plot.located, reason: '沿用上次判断（本次定位失败）' } : { actIndex: 0, reason: '定位失败，暂按第一幕', confidence: '低', pointHint: '' };
        }
    }
    plot.located = { ...located, canonId: canon.id, actsCount: detail.acts.length, title: detail.acts[located.actIndex]?.title || '', at: Date.now(), floor: (ctx().chat || []).length };
    saveState();
    emit({ located: plot.located });
    return canonPositionText(detail, located.actIndex, located);
}

/** 只重新定位，不推演。 */
export function locateNow({ onProgress, signal } = {}) {
    return guarded('locate', async (sig) => {
        const s = getSettings();
        const plot = getPlot();
        const canon = plot.canonId ? getCanon(plot.canonId) : null;
        if (!canon) throw new Error('先选择一本原著');
        const stage = await collectStage({ ...s, contextFloors: Math.max(1, Number(s.plot.contextFloors) || 12), includeWorldInfo: false });
        const text = await locateForCompass({ canon, plot, stage, sig, onProgress });
        if (!text) throw new Error('这本原著还没有幕目，先点「自动分幕」');
        return plot.located;
    }, signal);
}

export async function generateCompass({ onProgress, signal } = {}) {
    if (busy) throw new Error('剧情模块正忙');
    busy = 'compass';
    controller = new AbortController();
    const sig = signal || controller.signal;
    const s = getSettings();
    const st = getState();
    const plot = st.plot;
    const chatId = ctx().chatId;
    try {
        onProgress?.('正在读取舞台与设定…');
        const stage = await collectStage({ ...s, contextFloors: Math.max(1, Number(s.plot.contextFloors) || 12), includeWorldInfo: true });
        const canon = plot.canonId ? getCanon(plot.canonId) : null;
        let loreText = '';
        if (plot.loreBook && plot.loreUids?.length) {
            try {
                const entries = (await loadLoreEntries(plot.loreBook)).filter(e => plot.loreUids.includes(e.uid));
                loreText = entries.map(e => `【${e.comment || '条目'}】\n${e.content.trim()}`).join('\n\n').slice(0, 6000);
            } catch { /* 忽略 */ }
        }
        if (!loreText && stage.loreText) loreText = stage.loreText.slice(0, 4000);
        const npcs = st.npcs || [];
        const canonPosition = canon ? await locateForCompass({ canon, plot, stage, sig, onProgress }) : '';
        onProgress?.('正在推演走向…');
        const messages = buildCompassMessages({
            canonName: canon?.name, canonDigest: canon?.digest || '', canonPosition, loreText, stage,
            notes: plot.notes, previous: plot.compass ? compassToText(plot.compass, { brief: true }) : '',
            actorsBrief: actorsBrief(), npcsBrief: npcs.map(n => `- ${n.name}${n.role ? '（' + n.role + '）' : ''}`).join('\n'),
        });
        const conn = { ...plotConnection(), stream: false };
        const send = (msgs) => sendChat(conn, msgs, { maxTokens: 2200, temperature: 0.6, signal: sig, task: 'tool' });
        const compass = normalizeCompass(await requestJson(send, messages, { keys: ['now', 'inevitable', 'beats', 'guidance'], label: '走向 JSON' }));
        if (!compass || (!compass.guidance && !compass.beats.length && !compass.now)) throw new Error('模型没有返回可解析的走向 JSON');
        if (ctx().chatId !== chatId) throw new Error('聊天已切换，本次推演作废');
        if (plot.compass) {
            plot.history.unshift({ at: plot.compassAt, floor: plot.compassFloor, compass: plot.compass });
            if (plot.history.length > LIMITS.compassHistory) plot.history.length = LIMITS.compassHistory;
        }
        plot.compass = compass;
        plot.compassAt = Date.now();
        plot.compassFloor = (ctx().chat || []).length;
        plot.guidanceOverride = '';
        saveState();
        applyInjection();
        emit({ compass });
        return compass;
    } catch (err) {
        emit({ error: describeError(err) });
        throw err;
    } finally {
        busy = '';
        controller = null;
        emit({});
    }
}

export function clearCompass() {
    const plot = getPlot();
    plot.compass = null; plot.compassAt = null; plot.compassFloor = -1; plot.guidanceOverride = '';
    saveState();
    applyInjection();
    emit({});
}

/** 正文出新楼后：按设置自动推演。 */
export function onFloorRendered() {
    const s = getSettings();
    const every = Number(s.plot.autoEveryFloors) || 0;
    if (!every || busy) return;
    const plot = getPlot();
    const chat = ctx().chat || [];
    if (plot.compassFloor < 0 && !plot.canonId && !plot.notes && !plot.loreUids?.length) return; // 没配置过就不自动跑
    // 只数正文（AI）楼层，玩家发言不算
    const since = chat.slice(Math.max(0, plot.compassFloor)).filter(m => !m.is_system && !m.is_user).length;
    if (since >= every) {
        generateCompass().catch(err => console.warn('[PersonaArena] auto compass failed', err));
    }
}
