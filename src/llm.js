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
        .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '');
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

export function extractJson(text) {
    const s = String(text || '');
    const a = s.indexOf('{');
    const b = s.lastIndexOf('}');
    if (a < 0 || b <= a) return null;
    const candidate = s.slice(a, b + 1);
    try { return JSON.parse(candidate); } catch { /* 继续 */ }
    // 常见小错：尾逗号、单引号
    try { return JSON.parse(candidate.replace(/,\s*([}\]])/g, '$1').replace(/'/g, '"')); } catch { return null; }
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
