// 联网搜索与人设生成。搜索走酒馆后端（/api/search/*、/api/search/visit），没有 CORS 问题。

import { getSettings, getConnection } from './settings.js';
import { resolveConnection, sendChat, readSecretState } from './connections.js';
import { buildSheetGenerationMessages, buildNpcExtractionMessages } from './prompts.js';
import { extractJson, stripThinking } from './llm.js';
import { collectStage } from './stage.js';

function ctx() { return SillyTavern.getContext(); }
function headers() { return ctx().getRequestHeaders(); }

function decodeEntities(s) {
    const ta = document.createElement('textarea');
    ta.innerHTML = s;
    return ta.value;
}

function stripTags(s) {
    return decodeEntities(String(s || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

async function post(path, body) {
    const res = await fetch(path, { method: 'POST', headers: headers(), body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`${path} → ${res.status}`);
    return res;
}

async function tavily(query, max) {
    const data = await (await post('/api/search/tavily', { query })).json();
    const results = (data?.results || []).slice(0, max).map(r => ({ title: r.title, url: r.url, snippet: r.content }));
    if (data?.answer) results.unshift({ title: 'Tavily 摘要', url: '', snippet: data.answer });
    return results;
}

async function serper(query, max) {
    const data = await (await post('/api/search/serper', { query })).json();
    const results = (data?.organic || []).slice(0, max).map(r => ({ title: r.title, url: r.link, snippet: r.snippet }));
    if (data?.answerBox?.answer || data?.answerBox?.snippet) results.unshift({ title: '摘要', url: '', snippet: data.answerBox.answer || data.answerBox.snippet });
    return results;
}

async function searxng(query, max, baseUrl) {
    if (!baseUrl) throw new Error('未配置 SearXNG 地址');
    const html = await (await post('/api/search/searxng', { baseUrl, query })).text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const items = [...doc.querySelectorAll('article.result, .result')].slice(0, max);
    return items.map(el => ({
        title: stripTags(el.querySelector('h3, .result_header')?.innerHTML || ''),
        url: el.querySelector('a')?.getAttribute('href') || '',
        snippet: stripTags(el.querySelector('.content, p')?.innerHTML || ''),
    })).filter(r => r.title || r.snippet);
}

async function duckduckgo(query, max) {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const html = await (await post('/api/search/visit', { url, html: true })).text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const items = [...doc.querySelectorAll('.result')].slice(0, max);
    return items.map(el => {
        const a = el.querySelector('a.result__a');
        let href = a?.getAttribute('href') || '';
        const m = /uddg=([^&]+)/.exec(href);
        if (m) { try { href = decodeURIComponent(m[1]); } catch { /* 保留原值 */ } }
        return {
            title: stripTags(a?.innerHTML || ''),
            url: href,
            snippet: stripTags(el.querySelector('.result__snippet')?.innerHTML || ''),
        };
    }).filter(r => r.title || r.snippet);
}

async function hasSecret(key) {
    try {
        const state = await readSecretState();
        return Array.isArray(state?.[key]) && state[key].length > 0;
    } catch { return false; }
}

/** 返回 { provider, results:[{title,url,snippet}] } */
export async function webSearch(query) {
    const s = getSettings();
    const max = Math.max(1, Math.min(10, Number(s.search.maxResults) || 5));
    const pref = s.search.provider || 'auto';
    if (pref === 'off') return { provider: 'off', results: [] };
    const chain = [];
    if (pref === 'auto') {
        if (await hasSecret('api_key_tavily')) chain.push('tavily');
        if (await hasSecret('api_key_serper')) chain.push('serper');
        if (s.search.searxngUrl) chain.push('searxng');
        chain.push('duckduckgo');
    } else {
        chain.push(pref);
    }
    let lastErr = null;
    for (const p of chain) {
        try {
            let results;
            if (p === 'tavily') results = await tavily(query, max);
            else if (p === 'serper') results = await serper(query, max);
            else if (p === 'searxng') results = await searxng(query, max, s.search.searxngUrl);
            else results = await duckduckgo(query, max);
            if (results.length) return { provider: p, results };
        } catch (err) {
            lastErr = err;
            console.warn('[PersonaArena] search provider failed', p, err);
        }
    }
    if (lastErr) throw new Error(`搜索失败：${lastErr.message}`);
    return { provider: chain[chain.length - 1] || 'none', results: [] };
}

/** 抓一个网页的正文（用 Readability 提炼）。 */
export async function readPage(url, maxChars = 3000) {
    const html = await (await post('/api/search/visit', { url, html: true })).text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const { Readability } = SillyTavern.libs || {};
    let text = '';
    if (Readability) {
        try { text = new Readability(doc).parse()?.textContent || ''; } catch { text = ''; }
    }
    if (!text) text = doc.body?.textContent || '';
    return text.replace(/\s+/g, ' ').trim().slice(0, maxChars);
}

export function searchDigest(results, maxChars = 2500) {
    return results.map((r, i) => `${i + 1}. ${r.title}${r.url ? `（${r.url}）` : ''}\n${r.snippet}`).join('\n\n').slice(0, maxChars);
}

function workshopConnection(preferId) {
    const s = getSettings();
    return getConnection(preferId) || getConnection(s.workshopConnectionId) || resolveConnection();
}

function parseSheetJson(content) {
    const obj = extractJson(stripThinking(content));
    if (!obj || typeof obj !== 'object') throw new Error('模型没有返回可解析的人设 JSON');
    const pick = (k, n) => String(obj[k] ?? '').trim().slice(0, n);
    return {
        personality: pick('personality', 600),
        appearance: pick('appearance', 300),
        backstory: pick('backstory', 800),
        voice: pick('voice', 300),
        bottomLines: pick('bottomLines', 200),
        goals: pick('goals', 200),
        emoji: pick('emoji', 4) || '🎭',
    };
}

/**
 * 一键生成人设。onProgress(text) 用于 UI 反馈。
 * 返回 { sheet, searched:{provider, results} }
 */
export async function generateSheet({ name, source, hints, origin, useSearch, connectionId, onProgress }) {
    const conn = workshopConnection(connectionId);
    let searched = null;
    let digest = '';
    if (useSearch) {
        onProgress?.('正在联网搜索…');
        try {
            const q = source ? `${source} ${name} 人物 性格 设定` : `${name} 角色 人设`;
            searched = await webSearch(q);
            digest = searchDigest(searched.results);
            if (searched.results[0]?.url && digest.length < 800) {
                try { digest += '\n\n【正文摘录】\n' + await readPage(searched.results[0].url, 2000); } catch { /* 忽略 */ }
            }
        } catch (err) {
            onProgress?.(`搜索失败（${err.message}），改为凭模型知识生成…`);
        }
    }
    onProgress?.('正在撰写人设卡…');
    const messages = buildSheetGenerationMessages({ name, source, hints, searchDigest: digest, origin });
    const { content } = await sendChat({ ...conn, stream: false }, messages, { maxTokens: 1200, temperature: 0.8 });
    return { sheet: parseSheetJson(content), searched };
}

/** 从当前舞台提炼一个 NPC 的人设。 */
export async function extractNpcSheet({ npcName, connectionId, onProgress }) {
    const conn = workshopConnection(connectionId);
    onProgress?.('正在读取舞台与世界书…');
    const stage = await collectStage({ ...getSettings(), contextFloors: 20, includeWorldInfo: true });
    onProgress?.('正在提炼人设…');
    const messages = buildNpcExtractionMessages({ npcName, stage });
    const { content } = await sendChat({ ...conn, stream: false }, messages, { maxTokens: 1200, temperature: 0.7 });
    return parseSheetJson(content);
}

/** 从酒馆角色卡导入。 */
export function sheetFromCharacter(ch) {
    const cut = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
    return {
        personality: cut(ch.personality || ch.description, 600),
        appearance: '',
        backstory: cut(ch.description, 800),
        voice: cut(ch.mes_example, 300),
        bottomLines: '',
        goals: cut(ch.scenario, 200),
        emoji: '🎭',
    };
}

export function listCharacters() {
    const c = ctx();
    return (c.characters || []).map((ch, i) => ({ index: i, name: ch.name, avatar: ch.avatar })).filter(x => x.name);
}
