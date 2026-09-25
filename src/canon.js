// 原著：把长文本整理成「幕 → 剧情点」的分层结构，供剧情罗盘定位与推演。
// 索引（名字、概览、幕标题）存在设置里；幕的详细剧情点不大时也随设置走（跟着酒馆账号跨设备），
// 太大时只存浏览器 IndexedDB（localforage）。原文始终只存 IndexedDB。

import { getSettings, upsertCanon, removeCanon, uid } from './settings.js';
import { sendChat } from './connections.js';
import { requestJson, stripThinking } from './llm.js';
import {
    buildChunkPointsMessages, buildSectionMessages, buildActsGroupingMessages, buildActCompressMessages,
    buildOverviewMessages, buildKnowledgeCanonMessages, buildLocateMessages,
} from './prompts.js';

const detailCache = new Map();
const INLINE_LIMIT = 80_000;   // 幕目 JSON 不超过这个字数就直接存进设置
const KEY = (id) => `persona-arena_canon_detail_${id}`;
const PROGRESS = (k) => `persona-arena_canon_progress_${k}`;

function lf() { return (SillyTavern.libs || {}).localforage || null; }

// ---------- 存取 ----------

export async function loadCanonDetail(id) {
    if (!id) return null;
    if (detailCache.has(id)) return detailCache.get(id);
    let d = null;
    const canon = getSettings().canons.find(c => c.id === id);
    if (Array.isArray(canon?.acts) && canon.acts.length) d = { id, acts: canon.acts };
    if (!d) { try { d = lf() ? await lf().getItem(KEY(id)) : null; } catch { d = null; } }
    if (d && Array.isArray(d.acts)) { d.acts.forEach((a, i) => { a.index = i; a.points ??= []; a.characters ??= []; }); detailCache.set(id, d); return d; }
    return null;
}

export async function saveCanonDetail(id, detail) {
    detailCache.set(id, detail);
    let json = '';
    try { json = JSON.stringify(detail); } catch { json = ''; }
    // 先同步更新设置里的索引（调用方拿到返回值时索引已完整），再异步写 IndexedDB
    const canon = getSettings().canons.find(c => c.id === id);
    if (canon) {
        canon.actsCount = detail.acts.length;
        canon.actTitles = detail.acts.map(a => a.title).slice(0, 60);
        canon.hasDetail = true;
        // 不大就随设置走（酒馆设置存在服务端，换浏览器、换手机都在）；太大只留在这台浏览器的 IndexedDB
        if (json && json.length <= INLINE_LIMIT) { canon.acts = detail.acts; canon.detailInDb = false; }
        else { delete canon.acts; canon.detailInDb = true; }
        upsertCanon(canon);
    }
    try { if (lf()) await lf().setItem(KEY(id), detail); } catch (err) { console.warn('[PersonaArena] save canon detail failed', err); }
}

export async function deleteCanonDetail(id) {
    detailCache.delete(id);
    try { if (lf()) await lf().removeItem(KEY(id)); } catch { /* 忽略 */ }
}

export async function deleteCanon(id) {
    removeCanon(id);
    await deleteCanonDetail(id);
    try { if (lf()) await lf().removeItem(`persona-arena_canon_${id}`); } catch { /* 忽略 */ }
}

export function exportCanon(canon, detail) {
    return JSON.stringify({ format: 'persona-arena-canon', version: 1, canon, detail }, null, 2);
}

export async function importCanon(json) {
    if (json?.format !== 'persona-arena-canon' || !json.canon) throw new Error('不是本插件导出的原著文件');
    const canon = { ...json.canon, id: uid('canon') };
    upsertCanon(canon);
    if (json.detail?.acts) await saveCanonDetail(canon.id, json.detail);
    return canon;
}

// ---------- 文本切分 ----------

export function splitChunks(text, size) {
    const paras = String(text || '').replace(/\r\n?/g, '\n').split(/\n{2,}|\n(?=\s*(第[一二三四五六七八九十百千万零〇0-9]+[章节回卷部]|Chapter\s+\d+))/i).filter(Boolean);
    const chunks = [];
    let cur = '';
    for (const p of paras) {
        if (p.length > size) {
            if (cur) { chunks.push(cur); cur = ''; }
            for (let i = 0; i < p.length; i += size) chunks.push(p.slice(i, i + size));
            continue;
        }
        if ((cur + '\n\n' + p).length > size && cur) { chunks.push(cur); cur = p; }
        else cur = cur ? cur + '\n\n' + p : p;
    }
    if (cur) chunks.push(cur);
    return chunks;
}

function firstChapterTitle(chunk) {
    const m = /(第[一二三四五六七八九十百千万零〇0-9]+[章节回卷部][^\n]{0,30}|Chapter\s+\d+[^\n]{0,30})/i.exec(chunk);
    return m ? m[1].trim() : '';
}

// ---------- LLM 调用 ----------

function connFor() {
    const s = getSettings();
    const { getConnection } = { getConnection: (id) => s.connections.find(c => c.id === id) || null };
    return { ...(getConnection(s.plot.connectionId) || getConnection(s.workshopConnectionId) || s.connections[0] || { provider: 'st-current', model: '', temperature: 0.3, maxTokens: 1200, stream: false }), stream: false };
}

function sender({ maxTokens, temperature, signal }) {
    const conn = connFor();
    return (msgs) => sendChat(conn, msgs, { maxTokens, temperature, signal, task: 'tool' });
}

async function runPool(items, worker, parallel, signal) {
    const results = new Array(items.length);
    let next = 0;
    const lanes = Array.from({ length: Math.max(1, parallel) }, async () => {
        while (next < items.length) {
            if (signal?.aborted) throw new Error('已中止');
            const i = next++;
            results[i] = await worker(items[i], i);
        }
    });
    await Promise.all(lanes);
    return results;
}

const normPoints = (arr, max = 40) => (Array.isArray(arr) ? arr : []).map(x => (typeof x === 'string' ? x : (x?.text || x?.point || JSON.stringify(x)))).map(x => String(x).trim()).filter(Boolean).slice(0, max);
const normNames = (arr, max = 30) => [...new Set((Array.isArray(arr) ? arr : []).map(x => String(typeof x === 'string' ? x : (x?.name || '')).trim()).filter(Boolean))].slice(0, max);

// ---------- 主流程：TXT / 长文本 ----------

/**
 * 长文本 → 逐段剧情点 → 合节 → 分幕 → 每幕剧情点 → 概览。
 * 返回原著索引（幕的详细内容存 IndexedDB）。
 */
export async function buildCanonFromText({ name, text, sourceType = 'txt', onProgress, signal }) {
    const s = getSettings();
    const clean = String(text || '').trim();
    if (!clean) throw new Error('没有内容可总结');
    const chunkChars = Math.max(1500, Number(s.plot.chunkChars) || 6000);
    const sectionChunks = Math.max(2, Number(s.plot.sectionChunks) || 6);
    const parallel = Math.max(1, Math.min(6, Number(s.plot.parallel) || 2));
    const chunks = splitChunks(clean, chunkChars);
    const total = chunks.length;
    const progressKey = `${name}_${clean.length}_${chunkChars}`;

    // 断点续跑：同名同长度的文件复用已完成的段
    let cached = null;
    try { cached = lf() ? await lf().getItem(PROGRESS(progressKey)) : null; } catch { cached = null; }
    const chunkResults = Array.isArray(cached?.results) && cached.results.length === total ? cached.results : new Array(total).fill(null);
    let done = chunkResults.filter(Boolean).length;
    const startedAt = Date.now();
    let completedNow = 0;
    const report = (stage, extra = '') => {
        const elapsed = (Date.now() - startedAt) / 1000;
        const rate = completedNow > 0 ? elapsed / completedNow : 0;
        const eta = rate && done < total ? Math.round(rate * (total - done) / 60) : null;
        onProgress?.(`${stage} ${done}/${total} 段${eta !== null && eta > 0 ? ` · 预计还需约 ${eta} 分钟` : ''}${extra}`);
    };
    report('逐段提取剧情点');

    const send = sender({ maxTokens: 900, temperature: 0.2, signal });
    let sinceSave = 0;
    await runPool(chunks, async (chunk, i) => {
        if (chunkResults[i]) return chunkResults[i];
        const json = await requestJson(send, buildChunkPointsMessages({ name, index: i + 1, total, chunk, chapter: firstChapterTitle(chunk) }), { keys: ['points'], label: '段落剧情点' });
        const r = { points: normPoints(json.points, 12), characters: normNames(json.characters, 12), hooks: normPoints(json.hooks, 4), chapter: firstChapterTitle(chunk) };
        chunkResults[i] = r;
        done++; completedNow++;
        report('逐段提取剧情点');
        if (++sinceSave >= 5) { sinceSave = 0; try { if (lf()) await lf().setItem(PROGRESS(progressKey), { results: chunkResults, at: Date.now() }); } catch { /* 忽略 */ } }
        return r;
    }, parallel, signal);

    // 合节
    const groups = [];
    for (let i = 0; i < total; i += sectionChunks) groups.push({ from: i, to: Math.min(total, i + sectionChunks) - 1 });
    const sections = [];
    const sendSec = sender({ maxTokens: 1000, temperature: 0.2, signal });
    if (groups.length === 1 && total <= 2) {
        // 极短文本：直接把段落点当作一节
        const pts = chunkResults.flatMap(r => r.points);
        sections.push({ index: 0, title: chunkResults[0]?.chapter || name, summary: pts.slice(0, 3).join('；'), points: pts.slice(0, 20), characters: normNames(chunkResults.flatMap(r => r.characters)), chunkFrom: 0, chunkTo: total - 1 });
    } else {
        const secResults = await runPool(groups, async (g, gi) => {
            onProgress?.(`合并为节 ${gi + 1}/${groups.length}…`);
            const part = chunkResults.slice(g.from, g.to + 1);
            const json = await requestJson(sendSec, buildSectionMessages({ name, index: gi + 1, total: groups.length, chapters: part.map(r => r.chapter).filter(Boolean), points: part.flatMap(r => r.points), hooks: part.flatMap(r => r.hooks) }), { keys: ['points'], label: '节' });
            return { index: gi, title: String(json.title || part.find(r => r.chapter)?.chapter || `第 ${gi + 1} 节`).slice(0, 40), summary: String(json.summary || '').slice(0, 300), points: normPoints(json.points, 18), characters: normNames(part.flatMap(r => r.characters)), chunkFrom: g.from, chunkTo: g.to };
        }, parallel, signal);
        sections.push(...secResults);
    }

    const detail = await sectionsToActs({ name, sections, onProgress, signal });
    const overview = await overviewFromActs({ name, acts: detail.acts, maxChars: Number(s.plot.digestMaxChars) || 5000, signal, onProgress });
    const canon = upsertCanon({ id: uid('canon'), name, sourceType, digest: overview, chapters: [], chars: clean.length, chunks: total, createdAt: Date.now(), hasDetail: true, actsCount: detail.acts.length, actTitles: detail.acts.map(a => a.title) });
    await saveCanonDetail(canon.id, { id: canon.id, acts: detail.acts, sections: sections.map(x => ({ index: x.index, title: x.title, summary: x.summary })) });
    try { if (lf()) { await lf().setItem(`persona-arena_canon_${canon.id}`, clean); await lf().removeItem(PROGRESS(progressKey)); } } catch { /* 忽略 */ }
    return canon;
}

/** 节 → 幕（模型按阶段划分），并为每幕整理剧情点。 */
export async function sectionsToActs({ name, sections, onProgress, signal }) {
    let secs = sections;
    // 节太多时先两两合并，控制分幕提示词长度
    while (secs.length > 160) {
        const merged = [];
        for (let i = 0; i < secs.length; i += 2) {
            const a = secs[i], b = secs[i + 1];
            merged.push(b ? { ...a, title: a.title, summary: `${a.summary} ${b.summary}`.slice(0, 300), points: [...a.points, ...b.points], characters: normNames([...a.characters, ...b.characters]), chunkTo: b.chunkTo, merged: [a, b] } : a);
        }
        secs = merged;
    }
    let acts;
    if (secs.length <= 2) {
        acts = secs.map((sec, i) => ({ index: i, title: sec.title || `第 ${i + 1} 幕`, summary: sec.summary, from: i, to: i, points: sec.points, characters: sec.characters }));
    } else {
        onProgress?.('正在划分幕…');
        const send = sender({ maxTokens: 2200, temperature: 0.3, signal });
        const json = await requestJson(send, buildActsGroupingMessages({ name, sections: secs.map((x, i) => ({ index: i + 1, title: x.title, summary: x.summary, firstPoints: x.points.slice(0, 3) })) }), { keys: ['acts'], label: '分幕' });
        acts = normalizeActs(json.acts, secs.length).map((a, i) => {
            const own = secs.slice(a.from, a.to + 1);
            return { index: i, title: a.title, summary: a.summary, from: a.from, to: a.to, points: own.flatMap(x => x.points), characters: normNames(own.flatMap(x => x.characters)) };
        });
    }
    // 每幕剧情点过多则压缩
    const sendC = sender({ maxTokens: 1400, temperature: 0.2, signal });
    for (let i = 0; i < acts.length; i++) {
        if (acts[i].points.length > 40) {
            onProgress?.(`整理第 ${i + 1}/${acts.length} 幕的剧情点…`);
            const json = await requestJson(sendC, buildActCompressMessages({ name, title: acts[i].title, points: acts[i].points }), { keys: ['points'], label: '剧情点压缩' });
            acts[i].points = normPoints(json.points, 32);
            if (json.summary) acts[i].summary = String(json.summary).slice(0, 300);
        }
    }
    return { acts };
}

function normalizeActs(raw, sectionCount) {
    const list = (Array.isArray(raw) ? raw : []).map(a => ({
        title: String(a?.title || '').trim().slice(0, 40) || '未命名',
        summary: String(a?.summary || '').trim().slice(0, 300),
        from: Math.max(0, Math.min(sectionCount - 1, Number(a?.from ?? a?.start ?? 1) - 1)),
        to: Math.max(0, Math.min(sectionCount - 1, Number(a?.to ?? a?.end ?? sectionCount) - 1)),
    })).filter(a => a.to >= a.from).sort((a, b) => a.from - b.from);
    if (!list.length) return [{ title: '全篇', summary: '', from: 0, to: sectionCount - 1 }];
    // 修补空洞与重叠，保证连续覆盖
    let cursor = 0;
    for (const a of list) { a.from = Math.max(a.from, cursor); if (a.to < a.from) a.to = a.from; cursor = a.to + 1; }
    list[0].from = 0;
    list[list.length - 1].to = sectionCount - 1;
    return list.filter(a => a.to >= a.from);
}

async function overviewFromActs({ name, acts, maxChars, signal, onProgress }) {
    onProgress?.('正在写概览…');
    const send = sender({ maxTokens: 2400, temperature: 0.3, signal });
    const { content } = await send(buildOverviewMessages({ name, acts, maxChars }));
    return stripThinking(content).trim();
}

/** 只有梗概/提要而没有幕目的旧原著：从梗概（或逐段提要）自动分幕。 */
export async function structureActs({ canon, onProgress, signal }) {
    const source = (canon.chapters?.length ? canon.chapters.map(c => c.summary).join('\n\n') : canon.digest) || '';
    if (!source.trim()) throw new Error('这本原著没有可用来分幕的内容');
    const chunks = splitChunks(source, 3500);
    const send = sender({ maxTokens: 900, temperature: 0.2, signal });
    const results = await runPool(chunks, async (chunk, i) => {
        onProgress?.(`提取剧情点 ${i + 1}/${chunks.length}…`);
        const json = await requestJson(send, buildChunkPointsMessages({ name: canon.name, index: i + 1, total: chunks.length, chunk, chapter: '' }), { keys: ['points'], label: '剧情点' });
        return { points: normPoints(json.points, 14), characters: normNames(json.characters), hooks: [], chapter: '' };
    }, 2, signal);
    const sections = results.map((r, i) => ({ index: i, title: `第 ${i + 1} 节`, summary: r.points.slice(0, 2).join('；'), points: r.points, characters: r.characters, chunkFrom: i, chunkTo: i }));
    const detail = await sectionsToActs({ name: canon.name, sections, onProgress, signal });
    await saveCanonDetail(canon.id, { id: canon.id, acts: detail.acts });
    return detail;
}

// ---------- 同人：按作品名生成（含幕目） ----------

export async function buildCanonFromKnowledge({ name, hints, useSearch, onProgress, signal }) {
    let sources = '';
    let provider = '';
    if (useSearch) {
        onProgress?.('正在联网搜索原著资料…');
        try {
            const { webSearch, readPage, searchDigest } = await import('./search.js');
            const seen = new Set();
            const results = [];
            for (const q of [`${name} 剧情 梗概`, `${name} 人物 关系 结局`]) {
                if (signal?.aborted) throw new Error('已中止');
                const r = await webSearch(q);
                provider = r.provider;
                for (const x of r.results) if (x.url && !seen.has(x.url)) { seen.add(x.url); results.push(x); }
            }
            sources = searchDigest(results.slice(0, 8), 3500);
            const best = results.find(r => /wiki|百科|fandom|moegirl|萌娘/i.test(r.url)) || results[0];
            if (best?.url) { try { sources += '\n\n【正文摘录：' + best.url + '】\n' + await readPage(best.url, 3500); } catch { /* 忽略 */ } }
        } catch (err) {
            onProgress?.(`搜索失败（${err.message}），改为凭模型知识撰写…`);
        }
    }
    onProgress?.('正在撰写原著梗概与幕目…');
    const s = getSettings();
    const send = sender({ maxTokens: 4000, temperature: 0.4, signal });
    const json = await requestJson(send, buildKnowledgeCanonMessages({ name, hints, sources, maxChars: Number(s.plot.digestMaxChars) || 5000 }), { keys: ['overview', 'acts'], label: '原著 JSON' });
    const acts = (Array.isArray(json.acts) ? json.acts : []).map((a, i) => ({ index: i, title: String(a?.title || `第 ${i + 1} 幕`).slice(0, 40), summary: String(a?.summary || '').slice(0, 300), from: i, to: i, points: normPoints(a?.points, 20), characters: normNames(a?.characters) })).filter(a => a.points.length || a.summary);
    const overview = String(json.overview || '').trim();
    if (overview.length < 80 && !acts.length) throw new Error('模型没有写出可用的梗概');
    const canon = upsertCanon({ id: uid('canon'), name, sourceType: 'knowledge', digest: overview, chapters: [], chars: overview.length, chunks: 0, createdAt: Date.now(), searched: !!sources, provider, hasDetail: acts.length > 0, actsCount: acts.length, actTitles: acts.map(a => a.title) });
    if (acts.length) await saveCanonDetail(canon.id, { id: canon.id, acts });
    return canon;
}

// ---------- 定位与文本 ----------

export function actsBrief(detail, { maxPoints = 2 } = {}) {
    return (detail?.acts || []).map(a => `第${a.index + 1}幕《${a.title}》：${a.summary || ''}${a.points?.length ? '（' + a.points.slice(0, maxPoints).join('；') + '…）' : ''}`).join('\n');
}

export function actText(act, { label = '' } = {}) {
    if (!act) return '';
    return `${label}第${act.index + 1}幕《${act.title}》${act.summary ? '：' + act.summary : ''}\n${(act.points || []).map((p, i) => `  ${i + 1}. ${p}`).join('\n')}`;
}

/** 给罗盘的位置文本：当前幕全部剧情点 + 上一幕要点 + 下一幕剧情点。 */
export function canonPositionText(detail, actIndex, located) {
    const acts = detail?.acts || [];
    const i = Math.max(0, Math.min(acts.length - 1, Number(actIndex) || 0));
    const cur = acts[i], prev = acts[i - 1], next = acts[i + 1];
    const parts = [];
    parts.push(`【当前所在】第${i + 1}/${acts.length}幕《${cur.title}》${located?.reason ? '（定位依据：' + located.reason + '）' : ''}${located?.pointHint ? '，大约进行到：' + located.pointHint : ''}`);
    parts.push(actText(cur, { label: '【本幕剧情点（判断哪些已发生、哪些尚未发生）】\n' }));
    if (prev) parts.push(`【上一幕】第${prev.index + 1}幕《${prev.title}》：${prev.summary}${prev.points?.length ? '；末尾要点：' + prev.points.slice(-3).join('；') : ''}`);
    if (next) parts.push(actText(next, { label: '【下一幕（原著接下来）】\n' }));
    return parts.join('\n\n');
}

/** 让模型根据舞台记录判断当前处于哪一幕。 */
export async function locateAct({ canon, detail, stage, previous, signal }) {
    const acts = detail?.acts || [];
    if (!acts.length) return null;
    if (acts.length === 1) return { actIndex: 0, reason: '只有一幕', confidence: '高', pointHint: '' };
    const send = sender({ maxTokens: 500, temperature: 0.1, signal });
    const json = await requestJson(send, buildLocateMessages({ canonName: canon.name, actsBrief: actsBrief(detail, { maxPoints: 3 }), floors: (stage?.floors || []).slice(-8), previous }), { keys: ['actIndex'], label: '定位' });
    const idx = Math.max(0, Math.min(acts.length - 1, Number(json.actIndex) - 1));
    return { actIndex: Number.isFinite(idx) ? idx : 0, reason: String(json.reason || '').slice(0, 160), confidence: String(json.confidence || '').slice(0, 8), pointHint: String(json.pointHint || '').slice(0, 80) };
}
