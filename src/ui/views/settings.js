// 设置页：连接、回合、汇总模板、搜索、外观、数据。

import { h, add, clear, button, icon, toggle, toast, input, textarea, select, field, collapsible, confirmDialog } from '../dom.js';
import { getSettings, saveSettings, upsertConnection, removeConnection, DEFAULT_CONNECTION, uid, exportSettings, importSettings } from '../../settings.js';
import { PROVIDERS, listModels, storeKey, deleteStoredKey, listStoredKeys, listProfiles, requiresInlineKey, needsKey, testConnection, CLAUDE_MODELS } from '../../connections.js';
import { resetState } from '../../state.js';

export function renderSettings(root, app, params = {}) {
    const s = getSettings();
    let editingConn = params.editConnection ? structuredClone(s.connections.find(c => c.id === params.editConnection) || DEFAULT_CONNECTION) : null;

    const connSection = h('section', { class: 'pa-card pa-card-wide' });
    function renderConnections() {
        clear(connSection);
        add(connSection, h('div', { class: 'pa-section-title' }, icon('plug'), ' 连接', h('span', { class: 'pa-muted pa-small' }, '　每位演员可以用不同的接口、密钥与模型')));
        if (editingConn) { add(connSection, connectionEditor(editingConn)); return; }
        const list = h('div', { class: 'pa-conn-list' });
        for (const c of s.connections) {
            const p = PROVIDERS.find(x => x.id === c.provider);
            add(list, h('div', { class: 'pa-conn-item' },
                h('div', { class: 'pa-conn-main' },
                    h('b', {}, c.name || '（未命名）'),
                    h('span', { class: 'pa-muted pa-small' }, p?.label || c.provider, c.model ? ` · ${c.model}` : '', c.baseUrl ? ` · ${c.baseUrl}` : ''),
                    needsKey(c) ? h('span', { class: `pa-chip ${c.keyMode === 'inline' ? 'pa-chip-warn' : (c.secretId ? 'pa-chip-ok' : 'pa-chip-bad')}` }, c.keyMode === 'inline' ? (c.inlineKey ? '密钥明文保存' : '未填密钥') : (c.secretId ? '密钥在酒馆密钥库' : '未存密钥')) : null,
                ),
                h('div', { class: 'pa-row' },
                    button('', { icon: 'pen', kind: 'ghost small', title: '编辑', onClick: () => { editingConn = structuredClone(c); renderConnections(); } }),
                    button('', { icon: 'trash', kind: 'ghost small', title: '删除', onClick: async () => {
                        if (!(await confirmDialog('删除连接', `删除「${c.name}」？使用它的演员会退回默认连接；存入密钥库的密钥会一并删除。`))) return;
                        await deleteStoredKey(c); removeConnection(c.id); renderConnections();
                    } }),
                ),
            ));
        }
        add(list, button('新增连接', { icon: 'plus', kind: 'ghost', onClick: () => { editingConn = { ...structuredClone(DEFAULT_CONNECTION), id: '', provider: 'openai', name: '' }; renderConnections(); } }));
        add(connSection, list);
    }

    function connectionEditor(c) {
        const wrap = h('div', { class: 'pa-conn-editor' });
        const nameIn = input({ value: c.name, placeholder: '给这套连接起个名字，例如：Claude 主力 / DeepSeek 备用' });
        nameIn.addEventListener('input', () => { c.name = nameIn.value; });
        const provSel = select(PROVIDERS.map(p => ({ value: p.id, label: p.label })), { value: c.provider });
        const provHint = h('div', { class: 'pa-field-hint' });
        const urlIn = input({ value: c.baseUrl, placeholder: '例如 https://api.openai.com/v1 或中转站地址' });
        urlIn.addEventListener('input', () => { c.baseUrl = urlIn.value.trim(); refreshKeyArea(); });
        const urlField = field('接口地址', urlIn, 'OpenAI 兼容：填到 /v1 为止（后端会自动接 /chat/completions）。留空用官方地址。');
        const profSel = select([{ value: '', label: '选择连接配置…' }, ...listProfiles().map(p => ({ value: p.id, label: `${p.name}${p.model ? ' · ' + p.model : ''}` }))], { value: c.profileId });
        profSel.addEventListener('change', () => { c.profileId = profSel.value; });
        const profField = field('连接配置', profSel, '在酒馆的 API 连接页保存的"连接配置"。没有的话这里是空的。');
        const modelIn = input({ value: c.model, placeholder: '模型名，例如 gpt-4o / claude-sonnet-5 / deepseek-chat', list: 'pa-model-list' });
        modelIn.addEventListener('input', () => { c.model = modelIn.value.trim(); });
        const dl = h('datalist', { id: 'pa-model-list' });
        const fetchBtn = button('拉取模型', { icon: 'cloud-arrow-down', kind: 'ghost small', onClick: async () => {
            fetchBtn.disabled = true;
            try {
                const ids = await listModels(c);
                clear(dl); for (const id of ids) add(dl, h('option', { value: id }));
                toast('success', `拿到 ${ids.length} 个模型，输入框里可以下拉选`);
                if (!c.model && ids[0]) { modelIn.value = ids[0]; c.model = ids[0]; }
            } catch (err) { toast('error', err.message); } finally { fetchBtn.disabled = false; }
        } });
        const modelField = field('模型', h('div', { class: 'pa-row' }, modelIn, fetchBtn, dl), c.provider === 'st-current' ? '留空 = 酒馆当前模型。' : '');

        const keyArea = h('div', {});
        async function refreshKeyArea() {
            clear(keyArea);
            if (!needsKey(c)) return;
            const forcedInline = requiresInlineKey(c);
            if (forcedInline) c.keyMode = 'inline';
            const modeSel = select([{ value: 'secret', label: '存入酒馆密钥库（推荐）' }, { value: 'inline', label: '明文保存在插件设置里' }], { value: c.keyMode });
            modeSel.disabled = forcedInline;
            modeSel.addEventListener('change', () => { c.keyMode = modeSel.value; refreshKeyArea(); });
            add(keyArea, field('密钥保存方式', modeSel, forcedInline ? '⚠ Claude / Gemini 使用自定义地址时，酒馆后端只接受明文代理密码，因此只能明文保存。想避免，可改用 OpenAI 兼容中转。' : '密钥库与酒馆自己的 API Key 同一处，插件只记一个引用 ID。'));
            if (c.keyMode === 'inline') {
                const keyIn = input({ type: 'password', value: c.inlineKey, placeholder: 'sk-…', autocomplete: 'off' });
                keyIn.addEventListener('input', () => { c.inlineKey = keyIn.value.trim(); });
                add(keyArea, field('密钥', keyIn, '⚠ 明文保存在 settings.json 里，任何能读酒馆设置的扩展/角色卡脚本都可能读到。'));
            } else {
                const keyIn = input({ type: 'password', placeholder: c.secretId ? '已保存，输入新值可替换' : '粘贴密钥后点「存入」', autocomplete: 'off' });
                const storeBtn = button('存入密钥库', { icon: 'lock', kind: 'ghost small', onClick: async () => {
                    const v = keyIn.value.trim(); if (!v) { toast('warning', '先粘贴密钥'); return; }
                    storeBtn.disabled = true;
                    try {
                        if (!c.name) c.name = nameIn.value.trim() || PROVIDERS.find(p => p.id === c.provider)?.label || c.provider;
                        await deleteStoredKey(c);
                        const { id, label } = await storeKey(c, v);
                        c.secretId = id; c.secretLabel = label; keyIn.value = '';
                        toast('success', '密钥已存入酒馆密钥库'); refreshKeyArea();
                    } catch (err) { toast('error', err.message); } finally { storeBtn.disabled = false; }
                } });
                add(keyArea, field('密钥', h('div', { class: 'pa-row' }, keyIn, storeBtn), c.secretId ? `当前引用：${c.secretLabel || c.secretId}` : ''));
                const existing = await listStoredKeys(c.provider);
                if (existing.length) {
                    const reuse = select([{ value: '', label: '或复用酒馆里已有的密钥…' }, ...existing.map(k => ({ value: k.id, label: `${k.label}（${k.masked}）${k.active ? ' · 酒馆当前使用' : ''}` }))], { value: '' });
                    reuse.addEventListener('change', () => { if (!reuse.value) return; const k = existing.find(x => x.id === reuse.value); c.secretId = k.id; c.secretLabel = k.label; toast('success', '已引用该密钥'); refreshKeyArea(); });
                    add(keyArea, field('复用', reuse));
                }
            }
        }

        function refreshProvider() {
            const p = PROVIDERS.find(x => x.id === c.provider);
            provHint.textContent = p?.hint || '';
            urlField.hidden = !['openai', 'anthropic', 'gemini', 'deepseek'].includes(c.provider);
            profField.hidden = c.provider !== 'st-profile';
            modelField.hidden = c.provider === 'st-profile';
            extraField.hidden = c.provider !== 'openai';
            if (c.provider === 'anthropic') { clear(dl); for (const id of CLAUDE_MODELS) add(dl, h('option', { value: id })); }
            refreshKeyArea();
        }
        provSel.addEventListener('change', () => { c.provider = provSel.value; refreshProvider(); });

        const tempIn = input({ type: 'number', step: '0.05', min: 0, max: 2, value: c.temperature, class: 'pa-input pa-input-num' });
        tempIn.addEventListener('change', () => { c.temperature = tempIn.value === '' ? '' : Number(tempIn.value); });
        const maxIn = input({ type: 'number', step: 50, min: 50, max: 8000, value: c.maxTokens, class: 'pa-input pa-input-num' });
        maxIn.addEventListener('change', () => { c.maxTokens = Number(maxIn.value) || 800; });
        const streamT = toggle(c.stream, (v) => { c.stream = v; }, '流式输出');
        const extraTa = textarea({ value: c.extraHeaders, rows: 2, placeholder: 'X-Title: PersonaArena\nHTTP-Referer: https://…' });
        extraTa.addEventListener('input', () => { c.extraHeaders = extraTa.value; });
        const extraField = field('额外请求头', extraTa, '一行一个 "名字: 值"。OpenRouter 等需要时填。');

        const testBtn = button('测试连接', { icon: 'vial', kind: 'ghost', onClick: async () => {
            testBtn.disabled = true;
            try { const r = await testConnection(c); toast('success', `模型回复：${r || '（空）'}`, '连接成功'); }
            catch (err) { toast('error', err.message, '连接失败'); } finally { testBtn.disabled = false; }
        } });
        const saveBtn = button('保存连接', { icon: 'check', kind: 'primary', onClick: () => {
            c.name = nameIn.value.trim() || (PROVIDERS.find(p => p.id === c.provider)?.label || c.provider);
            if (!c.id) c.id = uid('conn');
            upsertConnection(c); editingConn = null; renderConnections(); toast('success', '连接已保存');
        } });
        const cancelBtn = button('取消', { kind: 'ghost', onClick: () => { editingConn = null; renderConnections(); } });

        add(wrap, 
            field('名称', nameIn),
            field('类型', provSel), provHint,
            urlField, profField, modelField, keyArea,
            h('div', { class: 'pa-row pa-wrap' }, field('温度', tempIn), field('最大输出 tokens', maxIn), streamT),
            extraField,
            h('div', { class: 'pa-row pa-editor-actions' }, saveBtn, testBtn, cancelBtn),
        );
        refreshProvider();
        return wrap;
    }

    // ---------- 回合 ----------
    const floorsIn = input({ type: 'number', min: 1, max: 30, value: s.contextFloors, class: 'pa-input pa-input-num' });
    floorsIn.addEventListener('change', () => { s.contextFloors = Math.max(1, Math.min(30, Number(floorsIn.value) || 5)); saveSettings(); });
    const maxCharsIn = input({ type: 'number', min: 60, max: 1500, step: 10, value: s.moveMaxChars, class: 'pa-input pa-input-num' });
    maxCharsIn.addEventListener('change', () => { s.moveMaxChars = Math.max(60, Number(maxCharsIn.value) || 220); saveSettings(); });
    const thresholdIn = input({ type: 'number', min: 10, max: 100, value: s.bondImportantThreshold, class: 'pa-input pa-input-num' });
    thresholdIn.addEventListener('change', () => { s.bondImportantThreshold = Math.max(10, Math.min(100, Number(thresholdIn.value) || 60)); saveSettings(); });
    const modeSel = select([{ value: 'sequential', label: '顺序：后出手者能看到前面的行动' }, { value: 'parallel', label: '并行：全员同时出手' }], { value: s.roundMode });
    modeSel.addEventListener('change', () => { s.roundMode = modeSel.value; saveSettings(); });
    const roundSection = h('section', { class: 'pa-card' },
        h('div', { class: 'pa-section-title' }, icon('masks-theater'), ' 回合'),
        field('读取最近几层', floorsIn),
        field('出手模式', modeSel),
        field('单次行动字数上限', maxCharsIn),
        field('"极重要的人"阈值', thresholdIn, '羁绊分值达到这个数，演员会为了 TA 拒绝玩家的指令。'),
        toggle(s.includeWorldInfo, (v) => { s.includeWorldInfo = v; saveSettings(); }, '把此刻触发的世界书交给演员'),
        toggle(s.includeCharacterCard, (v) => { s.includeCharacterCard = v; saveSettings(); }, '附带角色卡描述摘要'),
        toggle(s.includeSalonDigest, (v) => { s.includeSalonDigest = v; saveSettings(); }, '把沙龙最近的话作为幕后共识注入'),
        toggle(s.autoSend, (v) => { s.autoSend = v; saveSettings(); }, '回合结束自动发送到酒馆'),
        toggle(s.autoRoundOnReply, (v) => { s.autoRoundOnReply = v; saveSettings(); }, '主 AI 回复后自动开新回合（慎用）'),
    );

    // ---------- 汇总模板 ----------
    const tplTa = textarea({ value: s.dispatchTemplate, rows: 2 });
    tplTa.addEventListener('input', () => { s.dispatchTemplate = tplTa.value; saveSettings(); });
    const sepIn = input({ value: s.dispatchSeparator.replace(/\n/g, '\\n') });
    sepIn.addEventListener('change', () => { s.dispatchSeparator = sepIn.value.replace(/\\n/g, '\n'); saveSettings(); });
    const preIn = input({ value: s.dispatchPrefix, placeholder: '例如：（以下是各人此刻的动作）' });
    preIn.addEventListener('change', () => { s.dispatchPrefix = preIn.value; saveSettings(); });
    const sufIn = input({ value: s.dispatchSuffix, placeholder: '例如：请继续。' });
    sufIn.addEventListener('change', () => { s.dispatchSuffix = sufIn.value; saveSettings(); });
    const presetRow = h('div', { class: 'pa-row pa-wrap' },
        button('剧本式', { kind: 'ghost small', onClick: () => { s.dispatchTemplate = '【{{name}}】\n{{move}}'; s.dispatchSeparator = '\n\n'; tplTa.value = s.dispatchTemplate; sepIn.value = '\\n\\n'; saveSettings(); } }),
        button('紧凑式', { kind: 'ghost small', onClick: () => { s.dispatchTemplate = '{{name}}：{{move}}'; s.dispatchSeparator = '\n'; tplTa.value = s.dispatchTemplate; sepIn.value = '\\n'; saveSettings(); } }),
        button('引号式', { kind: 'ghost small', onClick: () => { s.dispatchTemplate = '{{emoji}} {{name}}\n"{{move}}"'; s.dispatchSeparator = '\n\n'; tplTa.value = s.dispatchTemplate; sepIn.value = '\\n\\n'; saveSettings(); } }),
    );
    const dispatchSection = h('section', { class: 'pa-card' },
        h('div', { class: 'pa-section-title' }, icon('scroll'), ' 汇总模板'),
        field('每位演员的块', tplTa, '可用 {{name}} {{move}} {{emoji}}'),
        field('块之间的分隔', sepIn, '用 \\n 表示换行'),
        field('整体前缀', preIn), field('整体后缀', sufIn),
        presetRow,
    );

    // ---------- 搜索 ----------
    const provSel = select([
        { value: 'auto', label: '自动（Tavily → Serper → SearXNG → DuckDuckGo）' },
        { value: 'tavily', label: 'Tavily（需在酒馆密钥库有 api_key_tavily）' },
        { value: 'serper', label: 'Serper（需 api_key_serper）' },
        { value: 'searxng', label: 'SearXNG（自建）' },
        { value: 'duckduckgo', label: 'DuckDuckGo（免密钥）' },
        { value: 'off', label: '关闭联网' },
    ], { value: s.search.provider });
    provSel.addEventListener('change', () => { s.search.provider = provSel.value; saveSettings(); });
    const sxIn = input({ value: s.search.searxngUrl, placeholder: 'https://searx.example.com' });
    sxIn.addEventListener('change', () => { s.search.searxngUrl = sxIn.value.trim(); saveSettings(); });
    const wsSel = select([{ value: '', label: '（演员自己的连接）' }, ...s.connections.map(c => ({ value: c.id, label: c.name }))], { value: s.workshopConnectionId });
    wsSel.addEventListener('change', () => { s.workshopConnectionId = wsSel.value; saveSettings(); });
    const tavilyIn = input({ type: 'password', placeholder: 'tvly-…', autocomplete: 'off' });
    const tavilyBtn = button('存入', { icon: 'lock', kind: 'ghost small', onClick: async () => {
        const v = tavilyIn.value.trim(); if (!v) return;
        try {
            const res = await fetch('/api/secrets/write', { method: 'POST', headers: SillyTavern.getContext().getRequestHeaders(), body: JSON.stringify({ key: 'api_key_tavily', value: v, label: 'PersonaArena' }) });
            if (!res.ok) throw new Error(String(res.status));
            tavilyIn.value = ''; toast('success', 'Tavily 密钥已存入酒馆密钥库');
        } catch (err) { toast('error', `写入失败：${err.message}`); }
    } });
    const searchSection = h('section', { class: 'pa-card' },
        h('div', { class: 'pa-section-title' }, icon('globe'), ' 联网与工坊'),
        field('搜索来源', provSel, '所有搜索都经酒馆后端发出，不受浏览器跨域限制。'),
        field('SearXNG 地址', sxIn),
        field('Tavily 密钥', h('div', { class: 'pa-row' }, tavilyIn, tavilyBtn), '可选。Tavily 结果质量最好，免费额度够用。'),
        field('工坊连接', wsSel, '生成人设、提炼 NPC 时用哪套连接。'),
    );

    // ---------- 外观 ----------
    const themeSel = select([{ value: 'ink', label: '墨与月（深色）' }, { value: 'paper', label: '宣纸（浅色）' }], { value: s.ui.theme });
    themeSel.addEventListener('change', () => { s.ui.theme = themeSel.value; saveSettings(); app.applyTheme(); });
    const accentIn = input({ type: 'color', value: s.ui.accent, class: 'pa-input pa-input-color' });
    accentIn.addEventListener('input', () => { s.ui.accent = accentIn.value; saveSettings(); app.applyTheme(); });
    const shellSel = select([{ value: 'auto', label: '自动（窄屏用抽屉）' }, { value: 'window', label: '总是浮窗' }, { value: 'sheet', label: '总是全屏抽屉' }], { value: s.ui.shell });
    shellSel.addEventListener('change', () => { s.ui.shell = shellSel.value; saveSettings(); app.applyTheme(); });
    const scaleIn = input({ type: 'range', min: 0.85, max: 1.25, step: 0.05, value: s.ui.fontScale });
    scaleIn.addEventListener('input', () => { s.ui.fontScale = Number(scaleIn.value); saveSettings(); app.applyTheme(); });
    const uiSection = h('section', { class: 'pa-card' },
        h('div', { class: 'pa-section-title' }, icon('palette'), ' 外观'),
        field('主题', themeSel), field('点睛色', accentIn), field('面板形态', shellSel), field('字号', scaleIn),
        toggle(s.ui.orbVisible, (v) => { s.ui.orbVisible = v; saveSettings(); app.orb?.show(v); }, '显示悬浮球（关闭后可从魔棒菜单或 /arena 打开）'),
        button('悬浮球回到默认位置', { icon: 'location-crosshairs', kind: 'ghost small', onClick: () => app.orb?.resetPosition() }),
    );

    // ---------- 数据 ----------
    const dataSection = h('section', { class: 'pa-card' },
        h('div', { class: 'pa-section-title' }, icon('database'), ' 数据'),
        h('div', { class: 'pa-row pa-wrap' },
            button('导出演员与设置', { icon: 'file-export', kind: 'ghost small', onClick: () => {
                const blob = new Blob([exportSettings()], { type: 'application/json' });
                const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `persona-arena-${Date.now()}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
            } }),
            button('导入', { icon: 'file-import', kind: 'ghost small', onClick: () => {
                const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'application/json';
                inp.addEventListener('change', async () => { const f = inp.files?.[0]; if (!f) return; try { importSettings(await f.text()); toast('success', '已导入'); app.refresh(); } catch (err) { toast('error', err.message); } });
                inp.click();
            } }),
            button('清空本聊天的竞技场记录', { icon: 'broom', kind: 'danger small', onClick: async () => { if (await confirmDialog('清空记录', '清空本聊天的回合、面板、沙龙、私语。演员与连接保留。')) { resetState(); toast('info', '已清空'); } } }),
        ),
        h('div', { class: 'pa-field-hint' }, '导出文件不包含明文密钥。演员面板、沙龙、私语记录随聊天文件保存，不在导出内。'),
    );

    add(root, 
        h('div', { class: 'pa-settings-grid' }, connSection, roundSection, dispatchSection, searchSection, uiSection, dataSection),
    );
    renderConnections();
}
