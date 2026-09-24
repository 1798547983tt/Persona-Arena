// 剧情页：原著来源、导演备注、走向推演、注入设置。

import { h, add, clear, button, icon, toggle, toast, input, textarea, select, field, collapsible, confirmDialog, fmtTime, renderRich } from '../dom.js';
import { getSettings, saveSettings, getCanon, upsertCanon } from '../../settings.js';
import { getPlot, saveState } from '../../state.js';
import { listLoreBooks, refreshLoreBooks, loadLoreEntries, summarizeText, canonFromLore, canonFromText, canonFromKnowledge, deleteCanon, readFileAsText, generateCompass, abortPlot, plotBusy, onPlotChange, compassToText, injectionText, applyInjection, clearCompass } from '../../plot.js';

const CHANCE_CLS = { '高': 'pa-chip-ok', '中': 'pa-chip-warn', '低': '' };

export function renderPlot(root, app) {
    const s = getSettings();
    const plot = getPlot();
    let loreBook = plot.loreBook || '';
    let loreEntries = [];
    let loreChecked = new Set(plot.loreUids || []);
    let newMode = 'knowledge';

    const canonSection = h('section', { class: 'pa-card pa-card-wide' });
    const notesSection = h('section', { class: 'pa-card pa-card-wide' });
    const compassSection = h('section', { class: 'pa-card pa-card-wide' });
    const progress = h('div', { class: 'pa-progress', hidden: true });
    function setProgress(t) { progress.hidden = !t; progress.textContent = t || ''; }

    // ---------- 原著 ----------
    function renderCanon() {
        clear(canonSection);
        const canons = getSettings().canons;
        const current = plot.canonId ? getCanon(plot.canonId) : null;
        const sel = select([{ value: '', label: '（无原著 · 自由剧情）' }, ...canons.map(c => ({ value: c.id, label: `${c.name} · ${c.sourceType === 'txt' ? 'TXT' : c.sourceType === 'lore' ? '世界书' : '手写'} · ${Math.round((c.digest || '').length / 100) / 10}k 字` }))], { value: plot.canonId || '' });
        sel.addEventListener('change', () => { plot.canonId = sel.value; saveState(); renderCanon(); });
        add(canonSection,
            h('div', { class: 'pa-section-title' }, icon('book'), ' 原著', h('span', { class: 'pa-muted pa-small' }, '　剧情走向以它为基准；也可以不选，纯凭故事本身推演')),
            field('当前原著', sel),
        );
        if (current) {
            const ta = textarea({ value: current.digest, rows: 10 });
            const save = button('保存修改', { icon: 'check', kind: 'ghost small', onClick: () => { current.digest = ta.value; upsertCanon(current); toast('success', '梗概已更新'); } });
            const del = button('删除此原著', { icon: 'trash', kind: 'danger small', onClick: async () => { if (await confirmDialog('删除原著', `删除「${current.name}」的梗概？`)) { await deleteCanon(current.id); renderCanon(); } } });
            add(canonSection, collapsible(`梗概 · ${current.name}（${current.chunks || 0} 段提要 → ${current.digest.length} 字，可手改）`, h('div', {}, ta, h('div', { class: 'pa-row pa-wrap' }, save, del))));
        }
        // 新建
        const MODE_META = { knowledge: ['wand-magic-sparkles', '同人：按作品名生成'], txt: ['file-lines', '导入 TXT 小说'], lore: ['book-atlas', '从世界书选条目'], manual: ['pen-nib', '手写梗概'] };
        const modes = h('div', { class: 'pa-row pa-wrap pa-seg' },
            Object.entries(MODE_META).map(([m, [ic, label]]) => h('button', { type: 'button', class: `pa-chip pa-chip-btn ${newMode === m ? 'active' : ''}`, onClick: () => { newMode = m; renderCanon(); } }, icon(ic), ' ', label)),
        );
        const box = h('div', { class: 'pa-newcanon' });
        if (newMode === 'knowledge') {
            const nameIn = input({ placeholder: '作品名，例如：某某传 / 某某动漫 第一季' });
            const hintIn = input({ placeholder: '可选：只到第几卷、以哪条线为主、忽略哪些设定…' });
            const useSearch = toggle(true, () => {}, '联网搜索资料');
            const go = button('生成原著梗概', { icon: 'wand-magic-sparkles', kind: 'primary small', onClick: async () => {
                const name = nameIn.value.trim();
                if (!name) { toast('warning', '先填作品名'); return; }
                go.disabled = true;
                try {
                    const canon = await canonFromKnowledge({ name, hints: hintIn.value.trim(), useSearch: useSearch.querySelector('input').checked, onProgress: setProgress });
                    plot.canonId = canon.id; saveState(); toast('success', `《${name}》梗概已生成${canon.searched ? '（含联网资料）' : '（凭模型知识）'}`); renderCanon();
                } catch (err) { toast('error', err.message); } finally { go.disabled = false; setProgress(''); }
            } });
            add(box, field('作品', nameIn), field('补充说明', hintIn), h('div', { class: 'pa-row pa-wrap' }, go, useSearch, button('中止', { kind: 'ghost small', onClick: () => abortPlot() })),
                h('div', { class: 'pa-field-hint' }, '写同人最省事的方式：知名作品直接凭模型知识写梗概，开联网可补最新资料；生成后记得看一眼、改掉不对的地方。'));
        } else if (newMode === 'txt') {
            const nameIn = input({ placeholder: '原著名字，例如：某某传' });
            const fileIn = h('input', { type: 'file', accept: '.txt,text/plain', class: 'pa-input pa-file' });
            const info = h('div', { class: 'pa-field-hint' }, '支持 UTF-8 / GBK 编码；按段落切成约 6000 字一段逐段提要，再汇总成梗概。长篇（百万字）需要较长时间和较多 token。');
            let text = '';
            fileIn.addEventListener('change', async () => {
                const f = fileIn.files?.[0]; if (!f) return;
                text = await readFileAsText(f);
                if (!nameIn.value.trim()) nameIn.value = f.name.replace(/\.txt$/i, '');
                info.textContent = `已读取 ${f.name}：${text.length.toLocaleString()} 字，预计 ${Math.ceil(text.length / (Number(getSettings().plot.chunkChars) || 6000))} 段。`;
            });
            const go = button('开始总结', { icon: 'wand-magic-sparkles', kind: 'primary small', onClick: async () => {
                if (!text.trim()) { toast('warning', '先选择 TXT 文件'); return; }
                const name = nameIn.value.trim() || '未命名原著';
                go.disabled = true;
                try {
                    const canon = await summarizeText({ name, text, sourceType: 'txt', onProgress: setProgress });
                    plot.canonId = canon.id; saveState(); toast('success', `《${name}》梗概已生成`); renderCanon();
                } catch (err) { toast('error', err.message); } finally { go.disabled = false; setProgress(''); }
            } });
            add(box, field('名字', nameIn), field('TXT 文件', fileIn), info, h('div', { class: 'pa-row pa-wrap' }, go, button('中止', { kind: 'ghost small', onClick: () => abortPlot() })));
        } else if (newMode === 'lore') {
            const books = listLoreBooks();
            const bookSel = select([{ value: '', label: books.length ? '选择世界书…' : '（没有读到世界书，点右侧刷新）' }, ...books.map(b => ({ value: b.name, label: `${b.name}${b.bound ? '（' + b.bound + '绑定）' : ''}` }))], { value: loreBook });
            const refreshBtn = button('', { icon: 'rotate', kind: 'ghost small', title: '重新读取世界书列表', onClick: async () => {
                refreshBtn.disabled = true;
                try { const bs = await refreshLoreBooks(); toast(bs.length ? 'success' : 'warning', bs.length ? `读到 ${bs.length} 本世界书` : '酒馆没有返回任何世界书'); renderCanon(); }
                catch (err) { toast('error', err.message); } finally { refreshBtn.disabled = false; }
            } });
            const list = h('div', { class: 'pa-lore-list' });
            async function loadList() {
                clear(list);
                if (!loreBook) return;
                add(list, h('div', { class: 'pa-muted pa-small' }, '读取中…'));
                try {
                    loreEntries = await loadLoreEntries(loreBook);
                    clear(list);
                    if (!loreEntries.length) add(list, h('div', { class: 'pa-muted pa-small' }, '这本世界书没有内容非空的条目。'));
                    for (const e of loreEntries) {
                        const cb = h('input', { type: 'checkbox' });
                        cb.checked = loreChecked.has(e.uid);
                        cb.addEventListener('change', () => { if (cb.checked) loreChecked.add(e.uid); else loreChecked.delete(e.uid); });
                        add(list, h('label', { class: `pa-lore-item ${e.disable ? 'disabled' : ''}` }, cb,
                            h('div', { class: 'pa-lore-main' },
                                h('b', {}, e.comment || e.key.slice(0, 3).join(' / ') || `#${e.uid}`),
                                h('span', { class: 'pa-muted pa-small' }, `${e.key.slice(0, 5).join('、') || '无关键词'}${e.constant ? ' · 常驻' : ''}${e.disable ? ' · 已禁用' : ''} · ${e.content.length} 字`),
                                h('div', { class: 'pa-lore-preview' }, e.content.slice(0, 120).replace(/\s+/g, ' ') + (e.content.length > 120 ? '…' : '')),
                            )));
                    }
                } catch (err) { clear(list); add(list, h('div', { class: 'pa-error' }, err.message)); }
            }
            bookSel.addEventListener('change', () => { loreBook = bookSel.value; loreChecked = new Set(); loadList(); });
            const nameIn = input({ placeholder: '原著名字（默认用世界书名）' });
            const allBtn = button('全选', { kind: 'ghost small', onClick: () => { loreEntries.forEach(e => loreChecked.add(e.uid)); list.querySelectorAll('input').forEach(i => { i.checked = true; }); } });
            const noneBtn = button('全不选', { kind: 'ghost small', onClick: () => { loreChecked.clear(); list.querySelectorAll('input').forEach(i => { i.checked = false; }); } });
            const asCanon = button('总结为原著', { icon: 'wand-magic-sparkles', kind: 'primary small', onClick: async () => {
                if (!loreBook || !loreChecked.size) { toast('warning', '先选世界书和条目'); return; }
                asCanon.disabled = true;
                try {
                    const canon = await canonFromLore({ book: loreBook, uids: [...loreChecked], name: nameIn.value.trim() || loreBook, onProgress: setProgress });
                    plot.canonId = canon.id; saveState(); toast('success', '已建为原著'); renderCanon();
                } catch (err) { toast('error', err.message); } finally { asCanon.disabled = false; setProgress(''); }
            } });
            const asLore = button('作为补充设定（推演时直接附带）', { icon: 'paperclip', kind: 'ghost small', onClick: () => {
                plot.loreBook = loreBook; plot.loreUids = [...loreChecked]; saveState();
                toast('success', `已附带 ${loreChecked.size} 条设定`); renderCanon();
            } });
            add(box, field('世界书', h('div', { class: 'pa-row' }, bookSel, refreshBtn), books.length ? '' : '列表为空时通常是酒馆版本较旧或世界书尚未加载；刷新会直接向酒馆服务器要列表。'), h('div', { class: 'pa-row pa-wrap' }, allBtn, noneBtn, h('span', { class: 'pa-muted pa-small' }, plot.loreUids?.length ? `当前附带：${plot.loreBook} · ${plot.loreUids.length} 条` : '')), list, field('名字', nameIn), h('div', { class: 'pa-row pa-wrap' }, asCanon, asLore));
            if (loreBook) loadList();
        } else {
            const nameIn = input({ placeholder: '原著名字' });
            const ta = textarea({ rows: 8, placeholder: '直接写下原著梗概：主线、人物、转折、设定、必然逻辑…' });
            const go = button('保存为原著', { icon: 'check', kind: 'primary small', onClick: () => {
                if (!ta.value.trim()) { toast('warning', '先写点内容'); return; }
                const canon = canonFromText({ name: nameIn.value.trim() || '手写原著', digest: ta.value });
                plot.canonId = canon.id; saveState(); toast('success', '已保存'); renderCanon();
            } });
            add(box, field('名字', nameIn), field('梗概', ta), go);
        }
        add(canonSection, h('div', { class: 'pa-kicker' }, '新建原著'), modes, box, progress);
    }

    // ---------- 导演备注 ----------
    function renderNotes() {
        clear(notesSection);
        const ta = textarea({ value: plot.notes, rows: 6, placeholder: '写给剧情顾问的话：你想让故事往哪走、哪些线必须保住、哪些人不能死、节奏快慢……优先级最高。' });
        ta.addEventListener('change', () => { plot.notes = ta.value; saveState(); });
        add(notesSection, h('div', { class: 'pa-section-title' }, icon('clapperboard'), ' 导演备注'), ta,
            h('div', { class: 'pa-field-hint' }, '备注会随每次推演一起交给顾问，也决定自动推演是否启用（没有原著、附带设定或备注时不会自动跑）。'));
    }

    // ---------- 罗盘 ----------
    function compassCard(kind, title, ic, body) {
        return h('section', { class: `pa-compass-card pa-compass-${kind}` }, h('div', { class: 'pa-compass-title' }, icon(ic), h('span', {}, title)), body);
    }
    function renderCompass() {
        clear(compassSection);
        const s2 = getSettings();
        const busy = plotBusy();
        const c = plot.compass;
        const head = h('div', { class: 'pa-stage-head' },
            h('div', { class: 'pa-stage-info' },
                h('div', { class: 'pa-kicker' }, c ? `罗盘 · 第 ${plot.compassFloor} 楼时推演` : '罗盘 · 尚未推演'),
                h('div', { class: 'pa-stage-meta' }, c ? `${fmtTime(plot.compassAt)} 生成${s2.plot.injectEnabled && plot.injectEnabled !== false ? ' · 已注入正文提示词' : ' · 未注入'} · 读最近 ${s2.plot.contextFloors || 12} 层正文` : `读原著 + 最近 ${s2.plot.contextFloors || 12} 层正文 + 世界书 + 备注，推演必然 / 脱离 / 不可能 / 可能 / 蝴蝶效应 / 原著接下来的事`),
            ),
            h('div', { class: 'pa-stage-actions' },
                busy ? button('中止', { icon: 'stop', kind: 'danger small', onClick: () => abortPlot() }) : null,
                button(busy === 'compass' ? '推演中…' : (c ? '重新推演' : '推演走向'), { icon: busy === 'compass' ? 'spinner fa-spin' : 'compass', kind: 'primary', disabled: !!busy, onClick: async () => {
                    try { await generateCompass({ onProgress: setProgress }); toast('success', '走向已更新'); } catch (err) { toast('error', err.message); } finally { setProgress(''); }
                } }),
            ),
        );
        const autoSel = select([{ value: '0', label: '手动' }, { value: '1', label: '每 1 层正文' }, { value: '2', label: '每 2 层正文' }, { value: '3', label: '每 3 层正文' }, { value: '5', label: '每 5 层正文' }, { value: '8', label: '每 8 层正文' }], { value: String(s2.plot.autoEveryFloors || 0) });
        autoSel.addEventListener('change', () => { s2.plot.autoEveryFloors = Number(autoSel.value); saveSettings(); });
        const depthIn = input({ type: 'number', min: 0, max: 20, value: s2.plot.injectDepth, class: 'pa-input pa-input-num' });
        depthIn.addEventListener('change', () => { s2.plot.injectDepth = Math.max(0, Number(depthIn.value) || 0); saveSettings(); applyInjection(); });
        const roleSel = select([{ value: '0', label: 'system' }, { value: '1', label: 'user' }, { value: '2', label: 'assistant' }], { value: String(s2.plot.injectRole || 0) });
        roleSel.addEventListener('change', () => { s2.plot.injectRole = Number(roleSel.value); saveSettings(); applyInjection(); });
        const floorsIn = input({ type: 'number', min: 1, max: 60, value: s2.plot.contextFloors || 12, class: 'pa-input pa-input-num' });
        floorsIn.addEventListener('change', () => { s2.plot.contextFloors = Math.max(1, Math.min(60, Number(floorsIn.value) || 12)); saveSettings(); });
        const controls = h('div', { class: 'pa-row pa-wrap pa-compass-controls' },
            field('读最近几层正文', floorsIn),
            field('自动推演', autoSel),
            toggle(s2.plot.injectEnabled && plot.injectEnabled !== false, (v) => { s2.plot.injectEnabled = v; plot.injectEnabled = v; saveSettings(); saveState(); applyInjection(); renderCompass(); }, '注入正文提示词'),
            field('注入深度', depthIn, '0 = 最后一条消息之后'),
            field('注入角色', roleSel),
            toggle(s2.plot.feedActors, (v) => { s2.plot.feedActors = v; saveSettings(); }, '演员也能看到走向'),
        );
        add(compassSection, h('div', { class: 'pa-section-title' }, icon('compass'), ' 剧情罗盘'), head, controls, progress);
        if (!c) {
            add(compassSection, h('div', { class: 'pa-empty pa-empty-poem' }, h('p', {}, '棋未落，局未定。'), h('p', {}, '选好原著或写下备注，点「推演走向」。之后每出几楼可自动更新，并作为幕后指引注入正文提示词。')));
            return;
        }
        const grid = h('div', { class: 'pa-compass-grid' });
        add(grid,
            compassCard('now', '当前局势', 'location-dot', h('div', {}, renderRich(c.now || '—'), c.position ? h('div', { class: 'pa-muted pa-small', style: { marginTop: '6px' } }, '原著进度：', c.position) : null)),
            compassCard('inevitable', '必然会发生', 'anchor', h('ul', {}, (c.inevitable || []).map(x => h('li', {}, x)), !c.inevitable?.length ? h('li', { class: 'pa-muted' }, '（无）') : null)),
            compassCard('deviated', '已脱离原著', 'code-branch', h('ul', {}, (c.deviated || []).map(d => h('li', {}, h('b', {}, d.what || ''), d.cause ? h('span', { class: 'pa-muted' }, `　因：${d.cause}`) : null, d.consequence ? h('div', { class: 'pa-small' }, '→ ', d.consequence) : null)), !c.deviated?.length ? h('li', { class: 'pa-muted' }, '（无）') : null)),
            compassCard('impossible', '已不可能发生', 'ban', h('ul', {}, (c.impossible || []).map(x => h('li', {}, x)), !c.impossible?.length ? h('li', { class: 'pa-muted' }, '（无）') : null)),
            compassCard('possible', '可能发生', 'dice', h('ul', {}, (c.possible || []).map(p => h('li', {}, h('span', { class: `pa-chip ${CHANCE_CLS[p.chance] || ''}` }, p.chance || '？'), ' ', p.what || '', p.trigger ? h('div', { class: 'pa-small pa-muted' }, '触发：', p.trigger) : null)), !c.possible?.length ? h('li', { class: 'pa-muted' }, '（无）') : null)),
            compassCard('butterflies', '蝴蝶效应', 'wind', h('ul', {}, (c.butterflies || []).map(b => h('li', {}, h('b', {}, b.origin || ''), h('div', { class: 'pa-chain' }, (b.chain || []).map(x => h('span', { class: 'pa-chain-step' }, x))), b.outcome ? h('div', { class: 'pa-small' }, '⇒ ', b.outcome) : null)), !c.butterflies?.length ? h('li', { class: 'pa-muted' }, '（无）') : null)),
            compassCard('canon', '原著接下来的事', 'timeline', h('ul', {}, (c.canonAhead || []).map(e => h('li', {}, h('span', { class: `pa-chip ${/如期|提前/.test(e.status || '') ? 'pa-chip-ok' : /不可能/.test(e.status || '') ? 'pa-chip-bad' : 'pa-chip-warn'}` }, e.status || '？'), ' ', e.event || '', e.why ? h('div', { class: 'pa-small pa-muted' }, e.why) : null)), !c.canonAhead?.length ? h('li', { class: 'pa-muted' }, '（无原著或无内容）') : null)),
            compassCard('ooc', 'OOC 提醒', 'user-shield', h('ul', {}, (c.oocRisks || []).map(x => h('li', {}, x)), !c.oocRisks?.length ? h('li', { class: 'pa-muted' }, '（无）') : null)),
            compassCard('beats', '接下来的节拍', 'music', h('ol', {}, (c.beats || []).map(x => h('li', {}, x)))),
        );
        const guidanceTa = textarea({ value: plot.guidanceOverride || c.guidance || '', rows: 4 });
        guidanceTa.addEventListener('change', () => { plot.guidanceOverride = guidanceTa.value.trim() === (c.guidance || '').trim() ? '' : guidanceTa.value; saveState(); applyInjection(); });
        const guidance = compassCard('guidance', '给正文的引导（可手改，改了以你的为准）', 'feather', h('div', {}, guidanceTa,
            h('div', { class: 'pa-row pa-wrap' },
                plot.guidanceOverride ? button('恢复顾问原文', { kind: 'ghost small', onClick: () => { plot.guidanceOverride = ''; saveState(); applyInjection(); renderCompass(); } }) : null,
                button('复制注入文本', { icon: 'copy', kind: 'ghost small', onClick: async () => { try { await navigator.clipboard.writeText(injectionText()); toast('success', '已复制'); } catch { toast('error', '复制失败'); } } }),
                button('清除罗盘', { icon: 'eraser', kind: 'ghost small', onClick: async () => { if (await confirmDialog('清除罗盘', '清除当前走向并取消注入。')) { clearCompass(); renderCompass(); } } }),
            )));
        add(compassSection, grid, guidance,
            collapsible('注入正文的实际文本', h('pre', { class: 'pa-dispatch-preview' }, injectionText())),
            plot.history?.length ? collapsible(`往期推演（${plot.history.length}）`, h('div', {}, plot.history.map(hh => h('div', { class: 'pa-history-entry' }, h('div', { class: 'pa-kicker' }, `第 ${hh.floor} 楼 · ${fmtTime(hh.at)}`), h('pre', { class: 'pa-dispatch-preview' }, compassToText(hh.compass)))))) : null,
        );
    }

    add(root, h('div', { class: 'pa-plot-grid' }, canonSection, notesSection, compassSection));
    renderCanon(); renderNotes(); renderCompass();

    const off = onPlotChange((d) => {
        if (d.progress !== undefined) return;
        if (d.canon) renderCanon();
        renderCompass();
    });
    return () => off();
}
