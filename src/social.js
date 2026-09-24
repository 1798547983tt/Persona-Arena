// 沙龙（故事外大群）与私语（玩家 ↔ 单个演员）。

import { getSettings, uid } from './settings.js';
import { getState, saveState, getActorState, pushSalon, getWhisper, pushWhisper, activeActors, getActor } from './state.js';
import { collectStage } from './stage.js';
import { buildSalonMessages, buildWhisperMessages } from './prompts.js';
import { generateFor, parseSalon, parseWhisper, describeError } from './llm.js';

const listeners = new Set();
let busy = false;
let controller = null;

export function onSocialChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}
function emit(detail = {}) {
    for (const fn of listeners) { try { fn(detail); } catch (e) { console.warn(e); } }
}
export function isSocialBusy() { return busy; }
export function abortSocial() { controller?.abort(); }

function parseMentions(text, actors) {
    const found = [];
    for (const a of actors) {
        if (new RegExp(`@\\s*${a.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(text)) found.push(a);
    }
    return found;
}

async function actorSpeaks(actor, stage, { mentioned = false, signal } = {}) {
    const settings = getSettings();
    const st = getState();
    const actors = activeActors();
    const messages = buildSalonMessages({ actor, state: getActorState(actor.id), stage, salon: st.salon, actors, settings, mentioned });
    const placeholder = pushSalon({ id: uid('sal'), ts: Date.now(), from: actor.id, fromName: actor.name, emoji: actor.emoji, color: actor.color, text: '', status: 'running' });
    emit({ typing: actor.id });
    try {
        const { content } = await generateFor(actor, messages, {
            signal,
            onToken: (cum) => { placeholder.text = parseSalon(cum).say; emit({ streaming: true }); },
        });
        const { say, pass } = parseSalon(content);
        if (pass || !say) {
            st.salon.splice(st.salon.indexOf(placeholder), 1);
        } else {
            placeholder.text = say.slice(0, 400);
            placeholder.status = 'done';
        }
    } catch (err) {
        placeholder.text = `（${describeError(err)}）`;
        placeholder.status = 'error';
    }
    saveState();
    emit({});
}

/** 玩家在沙龙发言；@某人则只让被点名者回应，否则全员依次决定是否开口。 */
export async function salonSend(text) {
    if (busy) throw new Error('沙龙里有人正在说话');
    const actors = activeActors();
    if (!actors.length) throw new Error('还没有启用的演员');
    const t = String(text || '').trim();
    if (!t) return;
    pushSalon({ id: uid('sal'), ts: Date.now(), from: 'player', fromName: '导演', text: t, status: 'done' });
    saveState();
    emit({});
    busy = true;
    controller = new AbortController();
    try {
        const stage = await collectStage({ ...getSettings(), includeWorldInfo: false });
        const mentioned = parseMentions(t, actors);
        const speakers = mentioned.length ? mentioned : actors;
        for (const a of speakers) {
            if (controller.signal.aborted) break;
            await actorSpeaks(a, stage, { mentioned: mentioned.includes(a), signal: controller.signal });
        }
    } finally {
        busy = false;
        controller = null;
        emit({ finished: true });
    }
}

/** 让演员们自己聊 n 轮。 */
export async function salonAutoTurns(n) {
    if (busy) throw new Error('沙龙里有人正在说话');
    const actors = activeActors();
    if (actors.length < 1) throw new Error('还没有启用的演员');
    busy = true;
    controller = new AbortController();
    try {
        const stage = await collectStage({ ...getSettings(), includeWorldInfo: false });
        const turns = Math.max(1, Math.min(6, Number(n) || 2));
        for (let t = 0; t < turns; t++) {
            // 每轮打乱顺序，避免总是同一个人先说
            const order = actors.slice().sort(() => Math.random() - 0.5);
            for (const a of order) {
                if (controller.signal.aborted) return;
                await actorSpeaks(a, stage, { signal: controller.signal });
            }
        }
    } finally {
        busy = false;
        controller = null;
        emit({ finished: true });
    }
}

export function clearSalon() {
    getState().salon = [];
    saveState();
    emit({});
}

/** 私语：玩家对某个演员说话；asInstruction 时演员会给出裁决。 */
export async function whisperSend(actorId, text, { asInstruction = false } = {}) {
    if (busy) throw new Error('有演员正在回应');
    const actor = getActor(actorId);
    if (!actor) throw new Error('找不到演员');
    const t = String(text || '').trim();
    if (!t) return;
    const history = getWhisper(actorId);
    pushWhisper(actorId, { id: uid('wh'), ts: Date.now(), from: 'player', kind: asInstruction ? 'instruction' : 'chat', text: t });
    saveState();
    emit({ actorId });
    busy = true;
    controller = new AbortController();
    const settings = getSettings();
    const state = getActorState(actorId);
    const reply = pushWhisper(actorId, { id: uid('wh'), ts: Date.now(), from: 'actor', kind: 'chat', text: '', status: 'running', decision: '' });
    emit({ actorId, typing: true });
    try {
        const stage = await collectStage({ ...settings, includeWorldInfo: false });
        const messages = buildWhisperMessages({ actor, state, history: history.slice(0, -1), text: t, asInstruction, settings, stage });
        const { content } = await generateFor(actor, messages, {
            signal: controller.signal,
            onToken: (cum) => { reply.text = parseWhisper(cum).reply; emit({ actorId, streaming: true }); },
        });
        const parsed = parseWhisper(content);
        reply.text = (parsed.reply || content.trim()).slice(0, 600);
        reply.status = 'done';
        if (asInstruction) {
            reply.kind = 'decision';
            reply.decision = parsed.decision || 'negotiate';
            if (reply.decision === 'accept') {
                state.pendingInstruction = { text: t, ts: Date.now() };
                state.chronicle.push({ round: null, ts: Date.now(), text: `私下答应了导演：${t.slice(0, 60)}` });
            } else if (reply.decision === 'refuse') {
                state.chronicle.push({ round: null, ts: Date.now(), text: `拒绝了导演的要求：${t.slice(0, 60)}` });
            }
        }
    } catch (err) {
        reply.text = `（${describeError(err)}）`;
        reply.status = 'error';
    } finally {
        busy = false;
        controller = null;
        saveState();
        emit({ actorId, finished: true });
    }
}

export function clearWhisper(actorId) {
    const st = getState();
    st.whispers[actorId] = [];
    saveState();
    emit({ actorId });
}

export function cancelPendingInstruction(actorId) {
    getActorState(actorId).pendingInstruction = null;
    saveState();
    emit({ actorId });
}
