// 舞台：读取最近楼层、干跑扫描世界书、把汇总文本送回酒馆。

let lastActivatedEntries = [];
let wired = false;

function ctx() { return SillyTavern.getContext(); }

export function wireStageEvents() {
    if (wired) return;
    wired = true;
    const { eventSource, event_types } = ctx();
    eventSource.on(event_types.WORLD_INFO_ACTIVATED, (entries) => {
        if (Array.isArray(entries)) {
            lastActivatedEntries = entries.map(e => ({
                world: e.world, uid: e.uid, comment: e.comment || '', content: e.content || '', key: Array.isArray(e.key) ? e.key.slice(0, 6) : [],
            }));
        }
    });
}

export function getLastActivatedEntries() {
    return lastActivatedEntries;
}

function messageText(m) {
    const t = Array.isArray(m.swipes) && m.swipes.length && Number.isInteger(m.swipe_id) ? (m.swipes[m.swipe_id] ?? m.mes) : m.mes;
    return String(t || '').trim();
}

export function recentFloors(n) {
    const { chat, name1 } = ctx();
    const list = (chat || []).filter(m => !m.is_system && !m.extra?.hidden && messageText(m));
    return list.slice(-Math.max(1, Number(n) || 5)).map(m => ({
        name: m.is_user ? (m.name || name1 || '玩家') : (m.name || '角色'),
        text: messageText(m),
        isUser: !!m.is_user,
    }));
}

function currentCharacter() {
    const c = ctx();
    if (c.characterId === undefined || c.characterId === null) return null;
    return c.characters?.[c.characterId] || null;
}

function stageNames() {
    const c = ctx();
    const ch = currentCharacter();
    let charName = ch?.name || '';
    if (!charName && c.groupId) {
        const g = c.groups?.find(x => x.id === c.groupId);
        charName = g?.name || '';
    }
    return { user: c.name1 || '', char: charName || c.name2 || '' };
}

function cardSummary() {
    const ch = currentCharacter();
    if (!ch) return '';
    const parts = [];
    if (ch.description) parts.push(String(ch.description).slice(0, 600));
    if (ch.scenario) parts.push(`场景：${String(ch.scenario).slice(0, 300)}`);
    return parts.join('\n');
}

/** 干跑扫描当前会被触发的世界书，返回 { text, before, after, depth } */
export async function scanLore() {
    const c = ctx();
    if (typeof c.getWorldInfoPrompt !== 'function') return { text: '', before: '', after: '', depth: [] };
    const chat = (c.chat || []).filter(m => !m.is_system && !m.extra?.hidden);
    const chatForWI = chat.map(m => `${m.name}: ${messageText(m)}`).reverse();
    const ch = currentCharacter();
    const globalScanData = {
        trigger: 'normal',
        personaDescription: '',
        characterDescription: ch?.description || '',
        characterPersonality: ch?.personality || '',
        characterDepthPrompt: ch?.data?.extensions?.depth_prompt?.prompt || '',
        scenario: ch?.scenario || '',
        creatorNotes: ch?.data?.creator_notes || '',
    };
    try {
        const r = await c.getWorldInfoPrompt(chatForWI, Number(c.maxContext) || 8192, true, globalScanData);
        const depth = (r?.worldInfoDepth || []).flatMap(d => Array.isArray(d.entries) ? d.entries : []);
        const an = [...(r?.anBefore || []), ...(r?.anAfter || [])];
        const sections = [r?.worldInfoBefore, ...an, ...depth, r?.worldInfoAfter].map(s => String(s || '').trim()).filter(Boolean);
        const text = sections.join('\n\n');
        return { text, before: r?.worldInfoBefore || '', after: r?.worldInfoAfter || '', depth };
    } catch (err) {
        console.warn('[PersonaArena] world info dry-run failed, falling back to last activated entries', err);
        const text = lastActivatedEntries.map(e => e.content).filter(Boolean).join('\n\n');
        return { text, before: '', after: '', depth: [] };
    }
}

/** 收集一次完整的舞台快照。 */
export async function collectStage(settings) {
    const floors = recentFloors(settings.contextFloors);
    const names = stageNames();
    let loreText = '';
    if (settings.includeWorldInfo) {
        const lore = await scanLore();
        loreText = lore.text.slice(0, 6000);
    }
    return {
        floors,
        names,
        loreText,
        cardSummary: settings.includeCharacterCard ? cardSummary() : '',
        chatId: ctx().chatId || '',
        takenAt: Date.now(),
    };
}

/** 把文本送进酒馆输入框并发送（等价于玩家手打）。 */
export async function sendToStage(text) {
    const ta = document.querySelector('#send_textarea');
    const btn = document.querySelector('#send_but');
    if (ta instanceof HTMLTextAreaElement && btn instanceof HTMLElement) {
        ta.value = text;
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        btn.click();
        return true;
    }
    const c = ctx();
    if (typeof c.executeSlashCommandsWithOptions === 'function') {
        const escaped = text.replace(/\|/g, '\\|');
        await c.executeSlashCommandsWithOptions(`/send ${escaped} | /trigger`);
        return true;
    }
    throw new Error('找不到酒馆的发送入口');
}

/** 只放进输入框，不发送。 */
export function putInInput(text) {
    const ta = document.querySelector('#send_textarea');
    if (!(ta instanceof HTMLTextAreaElement)) return false;
    ta.value = text;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.focus();
    return true;
}

export async function copyText(text) {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        let ok = false;
        try { ok = document.execCommand('copy'); } catch { ok = false; }
        ta.remove();
        return ok;
    }
}

export function isGenerating() {
    try {
        const c = ctx();
        return !!c.streamingProcessor || document.querySelector('#mes_stop')?.checkVisibility?.() === true;
    } catch { return false; }
}
