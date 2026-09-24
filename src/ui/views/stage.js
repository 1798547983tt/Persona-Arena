// 舞台页：开回合、看行动、汇总、发送。

import { h, add, clear, button, icon, toggle, renderRich, toast, textarea, collapsible, avatarBadge, fmtTime, confirmDialog } from '../dom.js';
import { getSettings, saveSettings } from '../../settings.js';
import { getState, activeActors, currentRound, saveState, getActor } from '../../state.js';
import { startRound, abortRound, isRunning, regenerateMove, setMoveText, composeDispatch, dispatchRound, onRoundChange } from '../../rounds.js';
import { recentFloors, scanLore } from '../../stage.js';
import { markMoves, settleMovesIfRedrawn, sweepComplete } from '../motion.js';

const STATUS_LABEL = { pending: '候场', running: '出手中', done: '已出手', error: '失败', aborted: '中止' };

export function renderStage(root, app) {
    const settings = getSettings();
    let viewing = currentRound();
    const st = getState();

    const head = h('div', { class: 'pa-stage-head' });
    const movesEl = h('div', { class: 'pa-moves' });
    const dispatchEl = h('div', { class: 'pa-dispatch' });
    const snapshotEl = h('div', {});
    const historyEl = h('div', { class: 'pa-history' });

    function renderHead() {
        clear(head);
        const actors = activeActors();
        const running = isRunning();
        const s = getSettings();
        const info = h('div', { class: 'pa-stage-info' },
            h('div', { class: 'pa-kicker' }, viewing ? `第 ${viewing.index} 回合` : '尚未开演'),
            h('div', { class: 'pa-stage-meta' },
                `${actors.length} 位演员在场`,
                ' · ',
                `读最近 ${s.contextFloors} 层`,
                s.includeWorldInfo ? ' · 附世界书' : '',
            ),
        );
        const modeBtn = button(s.roundMode === 'parallel' ? '并行' : '顺序', {
            icon: s.roundMode === 'parallel' ? 'layer-group' : 'list-ol', kind: 'ghost small',
            title: '顺序：后出手的演员能看到前面的行动；并行：全员同时出手',
            onClick: () => { s.roundMode = s.roundMode === 'parallel' ? 'sequential' : 'parallel'; saveSettings(); renderHead(); },
        });
        const auto = toggle(s.autoSend, (v) => { s.autoSend = v; saveSettings(); }, '出完自动发送');
        const startBtn = button(running ? '演员出手中…' : (viewing && viewing.status !== 'done' && viewing.status !== 'aborted' ? '继续' : '开始下一回合'), {
            icon: running ? 'spinner fa-spin' : 'play', kind: 'primary', disabled: running || !actors.length,
            onClick: async () => {
                try {
                    if (!actors.length) { toast('warning', '先到「演员」页添加并启用演员'); return; }
                    await startRound();
                } catch (err) { toast('error', err.message); }
            },
        });
        const abortBtn = running ? button('中止', { icon: 'stop', kind: 'danger small', onClick: () => abortRound() }) : null;
        add(head, info, h('div', { class: 'pa-stage-actions' }, modeBtn, auto, abortBtn, startBtn));
        if (!actors.length) {
            add(head, h('div', { class: 'pa-hint' }, '还没有演员。去「演员」页新建几位，或从角色卡 / 同人一键生成。'));
        }
    }

    function moveCard(m) {
        const actor = getActor(m.actorId) || { name: m.name, emoji: m.emoji, color: m.color };
        const card = h('article', { class: `pa-move pa-move-${m.status}`, dataset: { actorId: m.actorId }, style: { '--pa-actor': actor.color || 'var(--pa-accent)' } });
        const body = h('div', { class: 'pa-move-body' });
        const textEl = h('div', { class: 'pa-move-text' });
        if (m.text) add(textEl, renderRich(m.text));
        else if (m.status === 'running') add(textEl, h('span', { class: 'pa-thinking' }, '…正在酝酿'));
        else if (m.status === 'error') add(textEl, h('span', { class: 'pa-error' }, m.error || '失败'));
        else add(textEl, h('span', { class: 'pa-muted' }, '（候场）'));
        add(body, textEl);
        if (m.state && (m.state.mood || m.state.goal)) {
            add(body, h('div', { class: 'pa-move-state' },
                m.state.mood ? h('span', { class: 'pa-chip' }, icon('heart'), ` ${m.state.mood}`) : null,
                m.state.goal ? h('span', { class: 'pa-chip' }, icon('bullseye'), ` ${m.state.goal}`) : null,
            ));
        }
        const actions = h('div', { class: 'pa-move-actions' });
        if (!isRunning() && viewing) {
            add(actions, 
                button('', { icon: 'rotate', kind: 'ghost small', title: '重新出手', onClick: async () => { try { await regenerateMove(viewing, m.actorId); } catch (err) { toast('error', err.message); } } }),
                button('', { icon: 'pen', kind: 'ghost small', title: '手改', onClick: () => editMove(card, m) }),
            );
        }
        add(card, 
            h('header', { class: 'pa-move-head' },
                avatarBadge(actor, 'sm'),
                h('span', { class: 'pa-move-name' }, m.name),
                h('span', { class: `pa-badge pa-badge-${m.status}` }, STATUS_LABEL[m.status] || m.status),
                actions,
            ),
            body,
        );
        return card;
    }

    function editMove(card, m) {
        const ta = textarea({ value: m.text, rows: 4 });
        const save = button('保存', { icon: 'check', kind: 'primary small', onClick: () => { setMoveText(viewing, m.actorId, ta.value); } });
        const cancel = button('取消', { kind: 'ghost small', onClick: () => renderMoves() });
        const body = card.querySelector('.pa-move-body');
        clear(body);
        add(body, ta, h('div', { class: 'pa-row' }, save, cancel));
        ta.focus();
    }

    function renderMoves() {
        markMoves(movesEl, { live: isRunning() });
        settleMovesIfRedrawn(movesEl, isRunning());
        clear(movesEl);
        if (!viewing) {
            add(movesEl, h('div', { class: 'pa-empty pa-empty-poem' },
                h('p', {}, '幕未启，灯未亮。'),
                h('p', {}, '按下「开始下一回合」，每位演员会读一遍舞台上最近的事，然后各出一手。'),
            ));
            return;
        }
        for (const m of viewing.moves) add(movesEl, moveCard(m));
    }

    function renderDispatch() {
        clear(dispatchEl);
        if (!viewing) return;
        const text = composeDispatch(viewing);
        const preview = h('pre', { class: 'pa-dispatch-preview' }, text || '（还没有可汇总的行动）');
        const row = h('div', { class: 'pa-row pa-dispatch-actions' },
            button('复制', { icon: 'copy', kind: 'ghost', disabled: !text, onClick: async () => { try { await dispatchRound(viewing, 'copy'); toast('success', '已复制到剪贴板'); } catch (err) { toast('error', err.message); } } }),
            button('放进输入框', { icon: 'keyboard', kind: 'ghost', disabled: !text, onClick: async () => { try { await dispatchRound(viewing, 'input'); toast('info', '已放进酒馆输入框'); app.close(); } catch (err) { toast('error', err.message); } } }),
            button(viewing.dispatched ? '再次发送' : '发送到酒馆', { icon: 'paper-plane', kind: 'primary', disabled: !text || isRunning(), onClick: async () => {
                try { await dispatchRound(viewing, 'send'); toast('success', '已作为你的发言送上舞台'); app.close(); } catch (err) { toast('error', err.message); }
            } }),
        );
        add(dispatchEl, 
            h('div', { class: 'pa-section-title' }, icon('scroll'), ' 汇总', viewing.dispatched ? h('span', { class: 'pa-chip pa-chip-ok' }, `已发送 ${fmtTime(viewing.dispatchedAt)}`) : null),
            preview, row,
        );
    }

    async function renderSnapshot() {
        clear(snapshotEl);
        const s = getSettings();
        const floors = viewing?.stage?.floors || recentFloors(s.contextFloors);
        const list = h('div', { class: 'pa-floors' }, floors.map(f => h('div', { class: `pa-floor ${f.isUser ? 'user' : ''}` }, h('b', {}, f.name), h('span', {}, f.text.length > 240 ? f.text.slice(0, 240) + '…' : f.text))));
        const loreBox = h('div', { class: 'pa-lore' });
        const loreText = viewing?.stage?.loreText;
        if (viewing) {
            add(loreBox, loreText ? h('pre', {}, loreText.slice(0, 2000) + (loreText.length > 2000 ? '\n…' : '')) : h('span', { class: 'pa-muted' }, '（这一回合没有触发的世界书）'));
        } else if (s.includeWorldInfo) {
            add(loreBox, h('span', { class: 'pa-muted' }, '扫描中…'));
            scanLore().then(l => { clear(loreBox); add(loreBox, l.text ? h('pre', {}, l.text.slice(0, 2000)) : h('span', { class: 'pa-muted' }, '（此刻没有会触发的世界书）')); }).catch(() => { clear(loreBox); add(loreBox, h('span', { class: 'pa-muted' }, '（扫描失败）')); });
        }
        add(snapshotEl, collapsible(`舞台快照 · 最近 ${floors.length} 层${s.includeWorldInfo ? ' + 世界书' : ''}`, h('div', {}, list, h('div', { class: 'pa-kicker' }, '世界书'), loreBox)));
    }

    function renderHistory() {
        clear(historyEl);
        const rounds = getState().rounds;
        if (rounds.length <= 1) return;
        const items = rounds.slice().reverse().map(r => h('button', {
            type: 'button', class: `pa-history-item ${viewing?.id === r.id ? 'active' : ''}`,
            onClick: () => { viewing = r; renderAll(); },
        }, h('span', {}, `第 ${r.index} 回合`), h('span', { class: 'pa-muted' }, `${r.moves.filter(m => m.status === 'done').length}/${r.moves.length} 出手`), r.dispatched ? icon('check', 'pa-ok') : null));
        const clearBtn = button('清空历史', { icon: 'trash', kind: 'ghost small', onClick: async () => {
            if (!(await confirmDialog('清空回合历史', '只清空本聊天的回合记录，演员面板不受影响。'))) return;
            getState().rounds = []; saveState(); viewing = null; renderAll();
        } });
        add(historyEl, collapsible('往期回合', h('div', {}, h('div', { class: 'pa-history-list' }, items), clearBtn)));
    }

    function renderAll() {
        renderHead(); renderMoves(); renderDispatch(); renderSnapshot(); renderHistory();
    }

    add(root, head, movesEl, dispatchEl, snapshotEl, historyEl);
    renderAll();

    const off = onRoundChange((round, detail) => {
        markMoves(movesEl, { live: isRunning() });
        if (detail.started) { markMoves(movesEl, { settled: false }); viewing = round; renderAll(); return; }
        if (round.id !== viewing?.id) return;
        if (detail.streaming && detail.move) {
            const card = movesEl.querySelector(`[data-actor-id="${detail.move.actorId}"] .pa-move-text`);
            if (card) { clear(card); add(card, renderRich(detail.move.text || '…')); }
            return;
        }
        if (detail.move) {
            const old = movesEl.querySelector(`[data-actor-id="${detail.move.actorId}"]`);
            const fresh = moveCard(detail.move);
            if (old) old.replaceWith(fresh); else add(movesEl, fresh);
            renderDispatch();
            return;
        }
        if (detail.finished && !detail.move) {
            markMoves(movesEl, { settled: true });
            if (round.status === 'done') sweepComplete(movesEl);
        }
        renderAll();
    });
    return () => off();
}
