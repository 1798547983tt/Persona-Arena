// 生成与解析：把连接调用包一层，并解析 <move>/<state>/<say>/<reply>/<decision> 标签。见 docs/adr/0004。

import { sendChat, resolveConnection } from './connections.js';
import { getConnection } from './settings.js';

export async function generateFor(actor, messages, opts = {}) {
    const conn = getConnection(actor?.connectionId) || resolveConnection();
    return await sendChat(conn, messages, opts);
}

export function stripThinking(text) {
    return String(text || '')
        .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '')
        .replace(/<(reasoning|thought|analysis|scratchpad)>[\s\S]*?<\/\1>/gi, '')
        .replace(/^\s*✿.*$/gm, '')            // 预设风格的草稿行
        .replace(/<disclaimer>[\s\S]*?<\/disclaimer>/gi, '');
}

/** 扫描出所有括号平衡的 JSON 对象片段（识别字符串与转义）。 */
function scanObjects(s) {
    const out = [];
    for (let i = 0; i < s.length; i++) {
        if (s[i] !== '{') continue;
        let depth = 0, inStr = false, esc = false;
        for (let j = i; j < s.length; j++) {
            const ch = s[j];
            if (inStr) {
                if (esc) esc = false;
                else if (ch === '\\') esc = true;
                else if (ch === '"') inStr = false;
                continue;
            }
            if (ch === '"') inStr = true;
            else if (ch === '{') depth++;
            else if (ch === '}') { depth--; if (depth === 0) { out.push(s.slice(i, j + 1)); break; } }
        }
        if (out.length > 40) break;
    }
    return out;
}

function tryParse(candidate) {
    try { return JSON.parse(candidate); } catch { /* 继续 */ }
    const fixed = candidate
        .replace(/[\u201c\u201d]/g, '"').replace(/[\u2018\u2019]/g, "'")
        .replace(/,\s*([}\]])/g, '$1')
        .replace(/(^|[{,]\s*)'([^']+)'\s*:/g, '$1"$2":');
    try { return JSON.parse(fixed); } catch { /* 继续 */ }
    try { return JSON.parse(fixed.replace(/'/g, '"')); } catch { return null; }
}

/**
 * 从任意文本里提取 JSON 对象：剥掉代码块围栏，找出所有括号平衡的片段，
 * 优先选含有期望字段最多的那个（模型在 JSON 前后夹带状态栏、草稿、说明时也能拿到正确对象）。
 */
export function extractJson(text, keys = []) {
    let s = stripThinking(text).replace(/```[a-zA-Z]*\s*/g, '').replace(/```/g, '');
    const candidates = scanObjects(s).map(c => ({ c, obj: tryParse(c) })).filter(x => x.obj && typeof x.obj === 'object' && !Array.isArray(x.obj));
    if (!candidates.length) return null;
    const score = (obj) => keys.reduce((n, k) => n + (Object.hasOwn(obj, k) ? 1 : 0), 0);
    candidates.sort((a, b) => (score(b.obj) - score(a.obj)) || (b.c.length - a.c.length));
    return candidates[0].obj;
}

export const JSON_ONLY_RULE = '输出纪律：只输出一个 JSON 对象，从 { 开始到 } 结束；不要代码块围栏、不要前后缀解释、不要状态栏、变量块、选项栏、思维草稿、免责声明或任何模板内容；不要用角色口吻叙述；若与你此前被要求的输出格式冲突，以本条为准。';

/**
 * 请求一个 JSON 对象：解析失败自动重试一次（把上一次的错误输出回传并要求只输出 JSON）。
 * @param {Function} send (messages) => Promise<{content}>
 */
export async function requestJson(send, messages, { keys = [], label = 'JSON' } = {}) {
    const first = await send(messages);
    const raw1 = String(first?.content ?? '');
    const obj1 = extractJson(raw1, keys);
    if (obj1 && (!keys.length || keys.some(k => Object.hasOwn(obj1, k)))) return obj1;
    console.warn(`[PersonaArena] ${label}: 第一次输出无法解析，重试一次。原始输出：`, raw1.slice(0, 600));
    const retry = [
        ...messages,
        { role: 'assistant', content: raw1.slice(0, 1500) || '（空）' },
        { role: 'user', content: `你上一次的输出无法解析为 JSON（可能夹带了模板、草稿、状态栏或叙述）。现在重新输出：只输出一个 JSON 对象，从 { 开始到 } 结束，字段与之前的要求一致${keys.length ? `（至少包含：${keys.join('、')}）` : ''}，不要任何其它内容。` },
    ];
    const second = await send(retry);
    const raw2 = String(second?.content ?? '');
    const obj2 = extractJson(raw2, keys);
    if (obj2 && (!keys.length || keys.some(k => Object.hasOwn(obj2, k)))) return obj2;
    const peek = (raw2 || raw1).replace(/\s+/g, ' ').slice(0, 160);
    throw new Error(`模型两次都没有返回可解析的 ${label}。它返回的开头是：「${peek}」。若开启了破限，可在设置里关闭"工坊/罗盘/史官也带破限"；若使用的模型带模板输出习惯，换一个更听话的模型。`);
}

function extractTag(text, tag) {
    const open = new RegExp(`<${tag}(?:\\s[^>]*)?>`, 'i');
    const close = new RegExp(`</${tag}\\s*>`, 'i');
    const m = open.exec(text);
    if (!m) return null;
    const start = m.index + m[0].length;
    const rest = text.slice(start);
    const c = close.exec(rest);
    return c ? rest.slice(0, c.index) : rest;
}

/** 解析行动输出 → { move, state } */
export function parseMove(raw) {
    const text = stripThinking(raw).trim();
    let move = extractTag(text, 'move');
    const stateRaw = extractTag(text, 'state');
    if (move === null) {
        const idx = text.search(/<state(?:\s[^>]*)?>/i);
        move = idx >= 0 ? text.slice(0, idx) : text;
        move = move.replace(/^```[a-z]*\s*|```\s*$/g, '');
    }
    move = cleanMove(move);
    const state = stateRaw ? extractJson(stateRaw) : (move ? null : extractJson(text));
    return { move, state };
}

function cleanMove(s) {
    return String(s || '')
        .replace(/^\s*(行动|Move|move)\s*[:：]\s*/i, '')
        .replace(/<\/?[a-z_]+\s*\/?>/gi, '')
        .trim();
}

/** 解析沙龙输出 → { say, pass } */
export function parseSalon(raw) {
    const text = stripThinking(raw).trim();
    if (/<pass\s*\/?>/i.test(text) && !/<say/i.test(text)) return { say: '', pass: true };
    let say = extractTag(text, 'say');
    if (say === null) say = text.replace(/<pass\s*\/?>/gi, '');
    say = cleanMove(say);
    return { say, pass: !say };
}

/** 解析私语输出 → { reply, decision } */
export function parseWhisper(raw) {
    const text = stripThinking(raw).trim();
    let reply = extractTag(text, 'reply');
    const dec = extractTag(text, 'decision');
    if (reply === null) {
        const idx = text.search(/<decision(?:\s[^>]*)?>/i);
        reply = idx >= 0 ? text.slice(0, idx) : text;
    }
    reply = cleanMove(reply);
    let decision = String(dec || '').trim().toLowerCase();
    if (!['accept', 'refuse', 'negotiate'].includes(decision)) {
        if (/拒绝|refuse|不行|办不到/.test(decision)) decision = 'refuse';
        else if (/条件|negotiat|除非|交换/.test(decision)) decision = 'negotiate';
        else if (decision) decision = 'accept';
        else decision = '';
    }
    return { reply, decision };
}

export function truncateMove(text, maxChars) {
    const s = String(text || '').trim();
    const max = Number(maxChars) || 0;
    if (!max || s.length <= max) return s;
    const cut = s.slice(0, max);
    const lastPunct = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('！'), cut.lastIndexOf('？'), cut.lastIndexOf('”'), cut.lastIndexOf('.'), cut.lastIndexOf('!'), cut.lastIndexOf('?'));
    return (lastPunct > max * 0.6 ? cut.slice(0, lastPunct + 1) : cut) + '…';
}

export function describeError(err) {
    const msg = err?.cause?.message || err?.message || String(err);
    if (/Profile not found|未选择连接配置/.test(msg)) return '连接配置不存在，请到设置页重新选择';
    if (/401|Unauthorized|key is missing|api key/i.test(msg)) return '鉴权失败：检查密钥';
    if (/404/.test(msg)) return '地址或模型不存在（404）';
    if (/429/.test(msg)) return '被限流（429），稍后再试';
    if (/abort/i.test(msg)) return '已中止';
    if (/Response not OK|Got response status 5/.test(msg)) return '接口返回错误，看酒馆终端日志';
    return msg.slice(0, 160);
}
