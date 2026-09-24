// 沙龙页：故事外的大群。

import { h, add, clear, button, icon, renderRich, toast, textarea, avatarBadge, fmtTime, confirmDialog } from '../dom.js';
import { getSettings } from '../../settings.js';
import { getState, activeActors, getActor } from '../../state.js';
import { salonSend, salonAutoTurns, clearSalon, onSocialChange, isSocialBusy, abortSocial } from '../../social.js';

export function renderSalon(root, app) {
    const listEl = h('div', { class: 'pa-chat-list', role: 'log', 'aria-live': 'polite' });
    const input = textarea({ rows: 2, placeholder: '以导演身份说点什么… 用 @名字 只点名一位' });
    const actors = activeActors();

    function bubble(m) {
        const mine = m.from === 'player';
        const actor = mine ? null : (getActor(m.from) || { name: m.fromName, emoji: m.emoji, color: m.color });
        return h('div', { class: `pa-msg ${mine ? 'mine' : 'theirs'} ${m.status === 'running' ? 'running' : ''}`, dataset: { id: m.id } },
            mine ? null : avatarBadge(actor, 'sm'),
            h('div', { class: 'pa-bubble', style: { '--pa-actor': actor?.color || 'var(--pa-accent)' } },
                h('div', { class: 'pa-bubble-meta' }, h('b', {}, m.fromName), h('span', { class: 'pa-muted' }, fmtTime(m.ts))),
                h('div', { class: 'pa-bubble-text' }, m.text ? renderRich(m.text) : h('span', { class: 'pa-thinking' }, '…')),
            ),
        );
    }

    function renderList() {
        clear(listEl);
        const salon = getState().salon;
        if (!salon.length) {
            add(listEl, h('div', { class: 'pa-empty pa-empty-poem' },
                h('p', {}, '休息室里还没人说话。'),
                h('p', {}, '这里是故事之外：演员们会以"演员本人"的口吻聊天，吐槽、商量、顶嘴。你是导演。'),
            ));
        }
        for (const m of salon) add(listEl, bubble(m));
        listEl.scrollTop = listEl.scrollHeight;
    }

    const busyBar = h('div', { class: 'pa-busy-bar', hidden: true });
    function renderBusy() {
        const busy = isSocialBusy();
        busyBar.hidden = !busy;
        clear(busyBar);
        if (busy) add(busyBar, icon('spinner fa-spin'), ' 有人正在说话… ', button('打断', { kind: 'ghost small', onClick: () => abortSocial() }));
    }

    async function send() {
        const t = input.value.trim();
        if (!t) return;
        input.value = '';
        try { await salonSend(t); } catch (err) { toast('error', err.message); }
    }

    const mentionRow = h('div', { class: 'pa-mention-row' }, actors.map(a => h('button', { type: 'button', class: 'pa-chip pa-chip-btn', style: { '--pa-actor': a.color }, onClick: () => { input.value = (input.value + ` @${a.name} `).replace(/^\s+/, ''); input.focus(); } }, a.emoji, ' ', a.name)));

    const toolbar = h('div', { class: 'pa-row pa-chat-toolbar' },
        button(`让他们聊 ${getSettings().salonAutoTurns} 轮`, { icon: 'comments', kind: 'ghost small', onClick: async () => { try { await salonAutoTurns(getSettings().salonAutoTurns); } catch (err) { toast('error', err.message); } } }),
        button('清空', { icon: 'broom', kind: 'ghost small', onClick: async () => { if (await confirmDialog('清空沙龙', '只清空本聊天的沙龙记录。')) clearSalon(); } }),
    );

    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
    });

    add(root, 
        h('div', { class: 'pa-chat' },
            listEl,
            busyBar,
            h('div', { class: 'pa-chat-compose' },
                mentionRow,
                h('div', { class: 'pa-compose-row' }, input, button('', { icon: 'paper-plane', kind: 'primary', title: '发送', onClick: send })),
                toolbar,
            ),
        ),
    );
    renderList();
    renderBusy();

    const off = onSocialChange((d) => {
        if (d.streaming) {
            const last = getState().salon[getState().salon.length - 1];
            const el = last && listEl.querySelector(`[data-id="${last.id}"] .pa-bubble-text`);
            if (el) { clear(el); add(el, renderRich(last.text || '…')); listEl.scrollTop = listEl.scrollHeight; return; }
        }
        renderList(); renderBusy();
    });
    return () => off();
}
