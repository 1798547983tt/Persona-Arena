// 每个舞台（聊天）一份的运行态：回合、面板、沙龙、私语。存 chat_metadata['persona-arena']。

import { MODULE_NAME, getSettings } from './settings.js';

export const LIMITS = Object.freeze({
    rounds: 30,
    chronicle: 40,
    salon: 200,
    whisper: 120,
    bonds: 24,
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
    return st;
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
        };
    }
    const a = st.actorState[actorId];
    a.bonds ??= [];
    a.chronicle ??= [];
    return a;
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

/** 所有启用的演员，按顺序。 */
export function activeActors() {
    return getSettings().actors.filter(a => a.enabled && a.name);
}
