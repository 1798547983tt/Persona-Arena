// 回合：全体演员各出一手 → 汇总 → 复制/发送。

import { getSettings } from './settings.js';
import { getState, saveState, getActorState, applyStateUpdate, pushRound, activeActors, getActor } from './state.js';
import { collectStage, sendToStage, copyText, putInInput } from './stage.js';
import { buildMoveMessages, buildSalonDigest } from './prompts.js';
import { generateFor, parseMove, truncateMove, describeError } from './llm.js';
import { uid } from './settings.js';
import { plotFeedForActors } from './plot.js';

const listeners = new Set();
let running = null;   // { round, controller }

export function onRoundChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

function emit(round, detail = {}) {
    for (const fn of listeners) {
        try { fn(round, detail); } catch (e) { console.warn('[PersonaArena] listener error', e); }
    }
}

export function isRunning() { return !!running; }

export function abortRound() {
    running?.controller.abort();
}

function newRound(actors, stage) {
    const st = getState();
    const index = (st.rounds[st.rounds.length - 1]?.index ?? 0) + 1;
    return {
        id: uid('round'),
        index,
        startedAt: Date.now(),
        status: 'running',
        stage: { floors: stage.floors, loreText: stage.loreText, names: stage.names },
        moves: actors.map(a => ({ actorId: a.id, name: a.name, emoji: a.emoji, color: a.color, text: '', state: null, status: 'pending', error: '' })),
        dispatched: false,
        dispatchedAt: null,
    };
}

async function runMove(round, move, actor, stage, priorMoves, signal) {
    const settings = getSettings();
    const st = getState();
    const actorState = getActorState(actor.id);
    const pending = actorState.pendingInstruction?.text || '';
    const messages = buildMoveMessages({
        actor, state: actorState, stage, priorMoves, settings,
        salonDigest: settings.includeSalonDigest ? buildSalonDigest(st.salon) : '',
        pendingInstruction: pending,
        plotFeed: plotFeedForActors(),
    });
    move.status = 'running';
    move.error = '';
    move.text = '';
    emit(round, { move });
    try {
        const { content } = await generateFor(actor, messages, {
            signal,
            onToken: (cum) => {
                const { move: partial } = parseMove(cum);
                move.text = partial || cum.replace(/<\/?[a-z_]+[^>]*>/gi, '').trim();
                emit(round, { move, streaming: true });
            },
        });
        const parsed = parseMove(content);
        move.text = truncateMove(parsed.move || content.trim(), settings.moveMaxChars);
        move.state = parsed.state;
        move.status = move.text ? 'done' : 'error';
        if (!move.text) move.error = '模型没有给出行动';
        if (parsed.state) applyStateUpdate(actor.id, parsed.state, round.index);
        actorState.lastMove = move.text;
        if (pending && actorState.pendingInstruction) {
            actorState.chronicle.push({ round: round.index, ts: Date.now(), text: `执行了导演的私下指令：${pending.slice(0, 60)}` });
            actorState.pendingInstruction = null;
        }
    } catch (err) {
        move.status = signal?.aborted ? 'aborted' : 'error';
        move.error = describeError(err);
        console.warn('[PersonaArena] move failed', actor.name, err);
    }
    emit(round, { move });
}

/** 开始一个新回合。 */
export async function startRound() {
    if (running) throw new Error('已有回合在进行');
    const settings = getSettings();
    const actors = activeActors();
    if (!actors.length) throw new Error('还没有启用的演员');
    const stage = await collectStage(settings);
    const round = pushRound(newRound(actors, stage));
    const controller = new AbortController();
    running = { round, controller };
    saveState();
    emit(round, { started: true });
    try {
        if (settings.roundMode === 'parallel') {
            await Promise.all(actors.map((a, i) => runMove(round, round.moves[i], a, stage, [], controller.signal)));
        } else {
            const prior = [];
            for (let i = 0; i < actors.length; i++) {
                if (controller.signal.aborted) { round.moves[i].status = 'aborted'; continue; }
                await runMove(round, round.moves[i], actors[i], stage, prior.slice(), controller.signal);
                if (round.moves[i].status === 'done') prior.push({ name: actors[i].name, text: round.moves[i].text });
            }
        }
        round.status = controller.signal.aborted ? 'aborted' : 'done';
    } finally {
        running = null;
        saveState();
        emit(round, { finished: true });
    }
    if (round.status === 'done' && settings.autoSend) {
        await dispatchRound(round, 'send');
    }
    return round;
}

/** 重新生成某个演员的行动（顺序模式下把其他人已有行动当作上下文）。 */
export async function regenerateMove(round, actorId) {
    if (running) throw new Error('已有回合在进行');
    const settings = getSettings();
    const actor = getActor(actorId);
    const move = round.moves.find(m => m.actorId === actorId);
    if (!actor || !move) throw new Error('找不到演员');
    const stage = await collectStage(settings);
    const prior = round.moves.filter(m => m.actorId !== actorId && m.status === 'done').map(m => ({ name: m.name, text: m.text }));
    const controller = new AbortController();
    running = { round, controller };
    try {
        await runMove(round, move, actor, stage, settings.roundMode === 'parallel' ? [] : prior, controller.signal);
    } finally {
        running = null;
        saveState();
        emit(round, { finished: true });
    }
}

export function setMoveText(round, actorId, text) {
    const move = round.moves.find(m => m.actorId === actorId);
    if (!move) return;
    move.text = String(text || '').trim();
    move.status = move.text ? 'done' : 'error';
    saveState();
    emit(round, { move });
}

function fill(template, vars) {
    return String(template || '').replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] ?? ''));
}

export function composeDispatch(round, settings = getSettings()) {
    const blocks = round.moves
        .filter(m => m.status === 'done' && m.text)
        .map(m => fill(settings.dispatchTemplate, { name: m.name, move: m.text, emoji: m.emoji || '' }));
    const body = blocks.join(settings.dispatchSeparator ?? '\n\n');
    return [settings.dispatchPrefix, body, settings.dispatchSuffix].filter(s => s && s.trim()).join('\n');
}

/** mode: 'copy' | 'send' | 'input' */
export async function dispatchRound(round, mode = 'copy') {
    const text = composeDispatch(round);
    if (!text) throw new Error('这一回合没有可汇总的行动');
    if (mode === 'send') {
        await sendToStage(text);
        round.dispatched = true;
        round.dispatchedAt = Date.now();
        saveState();
        emit(round, { dispatched: true });
        return text;
    }
    if (mode === 'input') {
        putInInput(text);
        return text;
    }
    const ok = await copyText(text);
    if (!ok) throw new Error('复制失败，请手动选择文本');
    return text;
}
