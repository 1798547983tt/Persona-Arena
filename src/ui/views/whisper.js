// 私语页：玩家 ↔ 单个演员，可下指令，演员会裁决。

import { h, add, clear, button, icon, renderRich, toast, textarea, toggle, avatarBadge, fmtTime, confirmDialog } from '../dom.js';
import { getActor } from '../../settings.js';
import { getState, getWhisper, getActorState, activeActors } from '../../state.js';
import { whisperSend, clearWhisper, cancelPendingInstruction, onSocialChange, isSocialBusy, abortSocial } from '../../social.js';

const DECISION = {
    accept: { label: '接受', icon: 'check', cls: 'ok' },
    refuse: { label: '拒绝', icon: 'ban', cls: 'bad' },
    negotiate: { label: '讲条件', icon: 'scale-balanced', cls: 'warn' },
};

export function renderWhisper(root, app, params = {}) {
    const actors = activeActors();
    let actorId = params.actorId || actors[0]?.id || '';
    let asInstruction = false;

    const rail = h('div', { class: 'pa-actor-rail' });
    const listEl = h('div', { class: 'pa-chat-list', role: 'log' });
    const input = textarea({ rows: 2, placeholder: '悄悄对这位演员说…' });
    const pendingEl = h('div', {});
    const busyBar = h('div', { class: 'pa-busy-bar', hidden: true });

    function renderRail() {
        clear(rail);
        if (!actors.length) { add(rail, h('div', { class: 'pa-hint' }, '还没有演员。')); return; }
        for (const a of actors) {
            const pend = !!getActorState(a.id).pendingInstruction;
            add(rail, h('button', { type: 'button', class: `pa-rail-item ${a.id === actorId ? 'active' : ''}`, style: { '--pa-actor': a.color }, onClick: () => { actorId = a.id; renderAll(); } },
                avatarBadge(a, 'sm'), h('span', {}, a.name), pend ? h('span', { class: 'pa-dot-warn', title: '有待执行的指令' }) : null));
        }
    }

    function bubble(m, actor) {
        const mine = m.from === 'player';
        const dec = m.decision && DECISION[m.decision];
        return h('div', { class: `pa-msg ${mine ? 'mine' : 'theirs'}`, dataset: { id: m.id } },
            mine ? null : avatarBadge(actor, 'sm'),
            h('div', { class: 'pa-bubble', style: { '--pa-actor': actor?.color || 'var(--pa-accent)' } },
                h('div', { class: 'pa-bubble-meta' },
                    h('b', {}, mine ? '导演' : actor?.name),
                    m.kind === 'instruction' ? h('span', { class: 'pa-chip pa-chip-warn' }, icon('bolt'), ' 指令') : null,
                    dec ? h('span', { class: `pa-chip pa-chip-${dec.cls}` }, icon(dec.icon), ` ${dec.label}`) : null,
                    h('span', { class: 'pa-muted' }, fmtTime(m.ts)),
                ),
                h('div', { class: 'pa-bubble-text' }, m.text ? renderRich(m.text) : h('span', { class: 'pa-thinking' }, '…')),
            ),
        );
    }

    function renderList() {
        clear(listEl);
        const actor = getActor(actorId);
        if (!actor) { add(listEl, h('div', { class: 'pa-empty' }, '选一位演员。')); return; }
        const list = getWhisper(actorId);
        if (!list.length) {
            add(listEl, h('div', { class: 'pa-empty pa-empty-poem' },
                h('p', {}, `${actor.name} 在等你开口。`),
                h('p', {}, '普通聊天随便说；打开「作为指令」后，TA 会根据性格、底线和关系决定接受、拒绝还是讲条件。'),
            ));
        }
        for (const m of list) add(listEl, bubble(m, actor));
        listEl.scrollTop = listEl.scrollHeight;
    }

    function renderPending() {
        clear(pendingEl);
        const s = getActorState(actorId);
        if (s.pendingInstruction) {
            add(pendingEl, h('div', { class: 'pa-pending' },
                icon('bolt'), h('span', {}, '待执行指令：', s.pendingInstruction.text),
                button('撤回', { kind: 'ghost small', onClick: () => cancelPendingInstruction(actorId) }),
            ));
        }
    }

    function renderBusy() {
        const busy = isSocialBusy();
        busyBar.hidden = !busy;
        clear(busyBar);
        if (busy) add(busyBar, icon('spinner fa-spin'), ' 正在回应… ', button('打断', { kind: 'ghost small', onClick: () => abortSocial() }));
    }

    async function send() {
        const t = input.value.trim();
        if (!t || !actorId) return;
        input.value = '';
        try { await whisperSend(actorId, t, { asInstruction }); } catch (err) { toast('error', err.message); }
    }
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } });

    const instructionToggle = toggle(false, (v) => { asInstruction = v; input.placeholder = v ? '下达指令（TA 可能会拒绝）…' : '悄悄对这位演员说…'; }, '作为指令');
    const clearBtn = button('清空', { icon: 'broom', kind: 'ghost small', onClick: async () => { if (await confirmDialog('清空私语', '只清空与这位演员的私聊记录。')) clearWhisper(actorId); } });

    function renderAll() { renderRail(); renderList(); renderPending(); renderBusy(); }

    add(root, 
        h('div', { class: 'pa-whisper' },
            rail,
            h('div', { class: 'pa-chat' },
                listEl, pendingEl, busyBar,
                h('div', { class: 'pa-chat-compose' },
                    h('div', { class: 'pa-compose-row' }, input, button('', { icon: 'paper-plane', kind: 'primary', title: '发送', onClick: send })),
                    h('div', { class: 'pa-row pa-chat-toolbar' }, instructionToggle, clearBtn),
                ),
            ),
        ),
    );
    renderAll();

    const off = onSocialChange((d) => {
        if (d.actorId && d.actorId !== actorId) { renderRail(); return; }
        if (d.streaming) {
            const list = getWhisper(actorId);
            const last = list[list.length - 1];
            const el = last && listEl.querySelector(`[data-id="${last.id}"] .pa-bubble-text`);
            if (el) { clear(el); add(el, renderRich(last.text || '…')); listEl.scrollTop = listEl.scrollHeight; return; }
        }
        renderAll();
    });
    return () => off();
}
