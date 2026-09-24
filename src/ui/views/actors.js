// 演员页：演员卡、人设编辑、面板（心情/目标/羁绊/经历簿）。

import { h, add, clear, button, icon, toggle, toast, input, textarea, select, field, collapsible, avatarBadge, confirmDialog, promptDialog, renderRich } from '../dom.js';
import { getSettings, saveSettings, upsertActor, removeActor, moveActor, getActor, DEFAULT_ACTOR, getConnection } from '../../settings.js';
import { getActorState, saveState, clampBond } from '../../state.js';
import { PERSONALITY_PRESETS, ORIGIN_LABELS } from '../../prompts.js';
import { generateSheet, extractNpcSheet, sheetFromCharacter, listCharacters } from '../../search.js';
import { ensureDefaultConnection } from '../../connections.js';

const EMOJIS = ['🎭', '🗡️', '🌙', '🔥', '🌸', '🦊', '🐺', '🕊️', '⚔️', '🍶', '📜', '🌊', '🪶', '🎐', '🐉', '🧧'];
const COLORS = ['#d4482f', '#b97f12', '#3a7a5a', '#3b62a3', '#7a5c9e', '#b2486a', '#2f7f8c', '#7a6f5e'];

export function renderActors(root, app, params = {}) {
    ensureDefaultConnection();
    let mode = params.edit ? 'edit' : (params.actorId ? 'detail' : 'list');
    let editing = params.edit ? (getActor(params.edit) ? structuredClone(getActor(params.edit)) : newActor()) : null;
    let detailId = params.actorId || null;

    function newActor() {
        const a = structuredClone(DEFAULT_ACTOR);
        a.emoji = EMOJIS[Math.floor(Math.random() * EMOJIS.length)];
        a.color = COLORS[Math.floor(Math.random() * COLORS.length)];
        a.connectionId = getSettings().connections[0]?.id || '';
        return a;
    }

    function rerender() { clear(root); mode === 'edit' ? renderEditor() : mode === 'detail' ? renderDetail() : renderList(); }

    // ---------- 列表 ----------
    function renderList() {
        const actors = getSettings().actors;
        const grid = h('div', { class: 'pa-actor-grid' });
        for (const a of actors) {
            const st = getActorState(a.id);
            const conn = getConnection(a.connectionId);
            const card = h('article', { class: `pa-actor-card ${a.enabled ? '' : 'disabled'}`, style: { '--pa-actor': a.color }, onClick: () => { detailId = a.id; mode = 'detail'; rerender(); } },
                h('div', { class: 'pa-actor-card-head' },
                    avatarBadge(a, 'lg'),
                    h('div', { class: 'pa-actor-card-title' },
                        h('h3', {}, a.name || '（未命名）'),
                        h('div', { class: 'pa-muted pa-small' }, ORIGIN_LABELS[a.sheet.origin] || '原创', a.sheet.source ? ` · 《${a.sheet.source}》` : '', ' · ', conn ? conn.name : '未配置连接'),
                    ),
                ),
                h('div', { class: 'pa-actor-card-body' },
                    h('div', { class: 'pa-small' }, icon('heart'), ' ', st.mood || '平静', '　', icon('bullseye'), ' ', st.goal || '（无目标）'),
                    st.bonds.length ? h('div', { class: 'pa-bond-row' }, st.bonds.slice(0, 4).map(b => h('span', { class: `pa-chip ${b.score >= 60 ? 'pa-chip-ok' : b.score <= -60 ? 'pa-chip-bad' : ''}` }, `${b.target} ${b.score >= 0 ? '+' : ''}${b.score}`))) : null,
                ),
                h('div', { class: 'pa-actor-card-foot' },
                    h('span', { class: `pa-badge ${a.enabled ? 'pa-badge-done' : 'pa-badge-pending'}` }, a.enabled ? '在场' : '候补'),
                    h('span', { class: 'pa-muted pa-small' }, `${st.chronicle.length} 条经历`),
                ),
            );
            add(grid, card);
        }
        const addCard = h('button', { type: 'button', class: 'pa-actor-card pa-actor-add', onClick: () => { editing = newActor(); mode = 'edit'; rerender(); } }, icon('plus'), h('span', {}, '新演员'));
        add(grid, addCard);
        add(root, 
            h('div', { class: 'pa-section-title' }, icon('user-astronaut'), ' 演员表', h('span', { class: 'pa-muted pa-small' }, `　${actors.filter(a => a.enabled).length}/${actors.length} 在场`)),
            actors.length ? null : h('div', { class: 'pa-empty pa-empty-poem' }, h('p', {}, '一个人也演不成戏。'), h('p', {}, '点「新演员」，可以手写人设、套用性格预设、从角色卡导入、从舞台提炼 NPC，或联网搜索同人角色一键生成。')),
            grid,
        );
    }

    // ---------- 详情（面板） ----------
    function renderDetail() {
        const a = getActor(detailId);
        if (!a) { mode = 'list'; rerender(); return; }
        const st = getActorState(a.id);
        const head = h('div', { class: 'pa-detail-head', style: { '--pa-actor': a.color } },
            button('', { icon: 'arrow-left', kind: 'ghost', title: '返回', onClick: () => { mode = 'list'; rerender(); } }),
            avatarBadge(a, 'lg'),
            h('div', { class: 'pa-detail-title' }, h('h2', {}, a.name), h('div', { class: 'pa-muted pa-small' }, ORIGIN_LABELS[a.sheet.origin] || '原创', a.sheet.source ? ` · 《${a.sheet.source}》` : '')),
            h('div', { class: 'pa-row' },
                toggle(a.enabled, (v) => { a.enabled = v; upsertActor(a); }, '在场'),
                button('私语', { icon: 'feather-pointed', kind: 'ghost small', onClick: () => app.openTab('whisper', { actorId: a.id }) }),
                button('编辑人设', { icon: 'pen', kind: 'ghost small', onClick: () => { editing = structuredClone(a); mode = 'edit'; rerender(); } }),
                button('', { icon: 'arrow-up', kind: 'ghost small', title: '出手顺序提前', onClick: () => { moveActor(a.id, -1); toast('info', '顺序已调整'); } }),
                button('', { icon: 'arrow-down', kind: 'ghost small', title: '出手顺序靠后', onClick: () => { moveActor(a.id, 1); toast('info', '顺序已调整'); } }),
            ),
        );

        const moodIn = input({ value: st.mood, placeholder: '一句话心情' });
        const goalIn = input({ value: st.goal, placeholder: '一句话目标' });
        moodIn.addEventListener('change', () => { st.mood = moodIn.value.trim(); saveState(); });
        goalIn.addEventListener('change', () => { st.goal = goalIn.value.trim(); saveState(); });

        const bondsEl = h('div', { class: 'pa-bonds' });
        function renderBonds() {
            clear(bondsEl);
            if (!st.bonds.length) add(bondsEl, h('div', { class: 'pa-muted pa-small' }, '还没有形成关系。演员会在回合中自己记录；你也可以手动添加。'));
            for (const b of st.bonds) {
                const score = input({ type: 'number', min: -100, max: 100, value: b.score, class: 'pa-input pa-input-num' });
                const label = input({ value: b.label, placeholder: '标签', class: 'pa-input pa-input-sm' });
                score.addEventListener('change', () => { b.score = clampBond(score.value); saveState(); renderBonds(); });
                label.addEventListener('change', () => { b.label = label.value.trim().slice(0, 24); saveState(); });
                const bar = h('div', { class: 'pa-bond-bar' }, h('span', { class: `pa-bond-fill ${b.score < 0 ? 'neg' : ''}`, style: { width: `${Math.abs(b.score) / 2}%` } }));
                add(bondsEl, h('div', { class: 'pa-bond' },
                    h('b', {}, b.target), bar, score, label,
                    button('', { icon: 'xmark', kind: 'ghost small', title: '删除', onClick: () => { st.bonds = st.bonds.filter(x => x !== b); saveState(); renderBonds(); } }),
                    b.note ? h('div', { class: 'pa-bond-note pa-muted pa-small' }, b.note) : null,
                ));
            }
            add(bondsEl, button('添加关系', { icon: 'plus', kind: 'ghost small', onClick: async () => {
                const target = await promptDialog('添加关系', '对象名字（另一位演员或故事里的 NPC）');
                if (!target) return;
                st.bonds.push({ target: target.trim(), score: 0, label: '', note: '' }); saveState(); renderBonds();
            } }));
        }
        renderBonds();

        const chronicleEl = h('div', { class: 'pa-chronicle' });
        function renderChronicle() {
            clear(chronicleEl);
            if (!st.chronicle.length) add(chronicleEl, h('div', { class: 'pa-muted pa-small' }, '经历簿是空的。'));
            for (const c of st.chronicle.slice().reverse()) {
                add(chronicleEl, h('div', { class: 'pa-chronicle-item' }, h('span', { class: 'pa-kicker' }, c.round != null ? `回合 ${c.round}` : '幕后'), h('span', {}, c.text)));
            }
            if (st.chronicle.length) add(chronicleEl, button('清空经历', { icon: 'broom', kind: 'ghost small', onClick: async () => { if (await confirmDialog('清空经历簿', `清空 ${a.name} 在本聊天的所有经历。`)) { st.chronicle = []; saveState(); renderChronicle(); } } }));
        }
        renderChronicle();

        add(root, head,
            h('div', { class: 'pa-detail-grid', style: { '--pa-actor': a.color } },
                h('section', { class: 'pa-card' }, h('div', { class: 'pa-section-title' }, icon('heart'), ' 此刻'), field('心情', moodIn), field('目标', goalIn),
                    st.pendingInstruction ? h('div', { class: 'pa-pending' }, icon('bolt'), h('span', {}, '待执行指令：', st.pendingInstruction.text)) : null,
                    st.lastMove ? h('div', {}, h('div', { class: 'pa-kicker' }, '上一手'), renderRich(st.lastMove)) : null),
                h('section', { class: 'pa-card' }, h('div', { class: 'pa-section-title' }, icon('link'), ' 羁绊'), bondsEl),
                h('section', { class: 'pa-card pa-card-wide' }, h('div', { class: 'pa-section-title' }, icon('book-open'), ' 经历簿'), chronicleEl),
                h('section', { class: 'pa-card pa-card-wide' }, h('div', { class: 'pa-section-title' }, icon('id-card'), ' 人设卡'),
                    sheetView(a)),
            ),
        );
    }

    function sheetView(a) {
        const s = a.sheet;
        const preset = PERSONALITY_PRESETS.find(p => p.id === s.presetId);
        const rows = [
            ['性格底色', preset ? `${preset.name} — ${preset.text}` : ''],
            ['性格', s.personality], ['外貌', s.appearance], ['经历', s.backstory], ['口吻', s.voice], ['底线', s.bottomLines || preset?.bottomLines || ''], ['目标', s.goals],
        ].filter(r => r[1]);
        if (!rows.length) return h('div', { class: 'pa-muted pa-small' }, '人设卡还是空白的。');
        return h('dl', { class: 'pa-sheet' }, rows.map(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]));
    }

    // ---------- 编辑器 ----------
    function renderEditor() {
        const a = editing;
        const s = getSettings();
        const conns = s.connections;
        const nameIn = input({ value: a.name, placeholder: '演员名字（也是剧中名字）' });
        const emojiRow = h('div', { class: 'pa-emoji-row' }, EMOJIS.map(e => h('button', { type: 'button', class: `pa-emoji ${a.emoji === e ? 'active' : ''}`, onClick: (ev) => { a.emoji = e; [...emojiRow.children].forEach(c => c.classList.remove('active')); ev.currentTarget.classList.add('active'); } }, e)));
        const colorRow = h('div', { class: 'pa-color-row' }, COLORS.map(c => h('button', { type: 'button', class: `pa-color ${a.color === c ? 'active' : ''}`, style: { background: c }, 'aria-label': c, onClick: (ev) => { a.color = c; [...colorRow.children].forEach(x => x.classList.remove('active')); ev.currentTarget.classList.add('active'); } })));
        const connSel = select([{ value: '', label: '（默认：第一个连接）' }, ...conns.map(c => ({ value: c.id, label: `${c.name || c.provider}${c.model ? ' · ' + c.model : ''}` }))], { value: a.connectionId });
        connSel.addEventListener('change', () => { a.connectionId = connSel.value; });
        const originSel = select(Object.entries(ORIGIN_LABELS).map(([value, label]) => ({ value, label })), { value: a.sheet.origin });
        const sourceIn = input({ value: a.sheet.source, placeholder: '来源作品，例如：某某动漫 / 某某小说' });
        const sourceField = field('来源作品', sourceIn, '同人角色填这里；生成人设时会带着它去搜索。');
        sourceField.hidden = a.sheet.origin !== 'crossover';
        originSel.addEventListener('change', () => { a.sheet.origin = originSel.value; sourceField.hidden = a.sheet.origin !== 'crossover'; });
        sourceIn.addEventListener('input', () => { a.sheet.source = sourceIn.value.trim(); });
        const presetSel = select([{ value: '', label: '（不套预设）' }, ...PERSONALITY_PRESETS.map(p => ({ value: p.id, label: p.name }))], { value: a.sheet.presetId });
        const presetHint = h('div', { class: 'pa-field-hint' });
        function updPresetHint() { const p = PERSONALITY_PRESETS.find(x => x.id === presetSel.value); presetHint.textContent = p ? `${p.text} 底线：${p.bottomLines}` : ''; }
        updPresetHint();
        presetSel.addEventListener('change', () => { a.sheet.presetId = presetSel.value; updPresetHint(); });

        const tas = {};
        const mk = (key, label, rows, ph) => { const t = textarea({ value: a.sheet[key], rows, placeholder: ph }); t.addEventListener('input', () => { a.sheet[key] = t.value; }); tas[key] = t; return field(label, t); };
        const personalityF = mk('personality', '性格', 3, '具体、可演出来的细节：怎么说话、怎么对人、怕什么、要什么');
        const appearanceF = mk('appearance', '外貌', 2, '');
        const backstoryF = mk('backstory', '经历 / 背景', 3, '');
        const voiceF = mk('voice', '口吻与习惯', 2, '口癖、称呼、语速、爱用的比喻');
        const bottomF = mk('bottomLines', '底线（绝不做的事）', 2, '玩家的指令碰到这里会被拒绝');
        const goalsF = mk('goals', '长期目标', 2, '');
        const overrideT = textarea({ value: a.promptOverride, rows: 6, placeholder: '留空则使用内置的行动提示词。可用 {{name}}、{{max}}。' });
        overrideT.addEventListener('input', () => { a.promptOverride = overrideT.value; });

        function applySheet(sheet) {
            for (const k of ['personality', 'appearance', 'backstory', 'voice', 'bottomLines', 'goals']) { if (sheet[k]) { a.sheet[k] = sheet[k]; tas[k].value = sheet[k]; } }
            if (sheet.emoji && EMOJIS.includes(sheet.emoji)) { a.emoji = sheet.emoji; [...emojiRow.children].forEach(c => c.classList.toggle('active', c.textContent === sheet.emoji)); }
        }

        const progress = h('div', { class: 'pa-progress', hidden: true });
        function setProgress(t) { progress.hidden = !t; progress.textContent = t || ''; }

        const useSearch = toggle(true, () => {}, '联网搜索');
        const genBtn = button('一键生成人设', { icon: 'wand-magic-sparkles', kind: 'primary small', onClick: async () => {
            a.name = nameIn.value.trim();
            if (!a.name) { toast('warning', '先填名字'); return; }
            genBtn.disabled = true;
            try {
                const { sheet, searched } = await generateSheet({ name: a.name, source: a.sheet.source, origin: a.sheet.origin, hints: tas.personality.value.trim(), useSearch: useSearch.querySelector('input').checked, connectionId: a.connectionId, onProgress: setProgress });
                applySheet(sheet);
                toast('success', searched?.results?.length ? `已根据 ${searched.results.length} 条搜索结果生成` : '已生成人设');
            } catch (err) { toast('error', err.message); } finally { genBtn.disabled = false; setProgress(''); }
        } });
        const chars = listCharacters();
        const charSel = select([{ value: '', label: '从角色卡导入…' }, ...chars.map(c => ({ value: String(c.index), label: c.name }))]);
        charSel.addEventListener('change', () => {
            const ch = SillyTavern.getContext().characters?.[Number(charSel.value)];
            if (!ch) return;
            if (!nameIn.value.trim()) { nameIn.value = ch.name; a.name = ch.name; }
            a.sheet.origin = 'story'; originSel.value = 'story'; sourceField.hidden = true;
            applySheet(sheetFromCharacter(ch));
            toast('success', `已导入「${ch.name}」的资料`);
            charSel.value = '';
        });
        const npcBtn = button('从舞台提炼 NPC', { icon: 'magnifying-glass', kind: 'ghost small', onClick: async () => {
            const nm = nameIn.value.trim() || await promptDialog('提炼 NPC', 'NPC 的名字');
            if (!nm) return;
            nameIn.value = nm; a.name = nm; a.sheet.origin = 'story'; originSel.value = 'story'; sourceField.hidden = true;
            npcBtn.disabled = true;
            try { applySheet(await extractNpcSheet({ npcName: nm, connectionId: a.connectionId, onProgress: setProgress })); toast('success', '已从舞台提炼'); }
            catch (err) { toast('error', err.message); } finally { npcBtn.disabled = false; setProgress(''); }
        } });

        const saveBtn = button('保存演员', { icon: 'check', kind: 'primary', onClick: () => {
            a.name = nameIn.value.trim();
            if (!a.name) { toast('warning', '名字不能为空'); return; }
            upsertActor(a);
            toast('success', `「${a.name}」已就位`);
            detailId = a.id; mode = 'detail'; rerender();
        } });
        const delBtn = a.id ? button('删除', { icon: 'trash', kind: 'danger', onClick: async () => { if (await confirmDialog('删除演员', `确定删除「${a.name}」？面板与私语记录会一并失效。`)) { removeActor(a.id); mode = 'list'; rerender(); } } }) : null;
        const cancelBtn = button('取消', { kind: 'ghost', onClick: () => { mode = a.id ? 'detail' : 'list'; detailId = a.id; rerender(); } });

        add(root, 
            h('div', { class: 'pa-detail-head' }, button('', { icon: 'arrow-left', kind: 'ghost', onClick: () => cancelBtn.click() }), h('h2', {}, a.id ? '编辑人设' : '新演员')),
            h('div', { class: 'pa-editor' },
                h('section', { class: 'pa-card' },
                    h('div', { class: 'pa-section-title' }, icon('id-card'), ' 身份'),
                    field('名字', nameIn), field('徽记', emojiRow), field('颜色', colorRow),
                    field('连接', connSel, '这位演员用哪套 API 与模型。到「设置」页可以添加更多连接。'),
                    field('来历', originSel), sourceField,
                    field('性格预设', presetSel), presetHint,
                ),
                h('section', { class: 'pa-card' },
                    h('div', { class: 'pa-section-title' }, icon('wand-magic-sparkles'), ' 工坊'),
                    h('div', { class: 'pa-row pa-wrap' }, genBtn, useSearch, charSel, npcBtn),
                    progress,
                    h('div', { class: 'pa-field-hint' }, '一键生成会用演员自己的连接（或设置里指定的工坊连接）写出下面各项；已有内容会被覆盖。'),
                ),
                h('section', { class: 'pa-card pa-card-wide' },
                    h('div', { class: 'pa-section-title' }, icon('feather'), ' 人设卡'),
                    personalityF, appearanceF, backstoryF, voiceF, bottomF, goalsF,
                    collapsible('高级：自定义行动提示词', field('完全替换内置提示词', overrideT)),
                ),
            ),
            h('div', { class: 'pa-row pa-editor-actions' }, saveBtn, cancelBtn, delBtn),
        );
    }

    rerender();
}
