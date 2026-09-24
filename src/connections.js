// 连接：把演员的 API 配置翻译成酒馆后端能懂的请求。见 docs/adr/0002、0003。

import { getSettings, saveSettings } from './settings.js';
import { withJailbreak } from './jailbreak.js';

const OFFICIAL_URLS = Object.freeze({
    openai: 'https://api.openai.com/v1',
    anthropic: 'https://api.anthropic.com/v1',
    gemini: 'https://generativelanguage.googleapis.com',
    deepseek: 'https://api.deepseek.com',
});

export const PROVIDERS = Object.freeze([
    { id: 'st-current', label: '酒馆当前连接', hint: '零配置：用酒馆此刻连着的 API 与模型。' },
    { id: 'st-profile', label: '酒馆连接配置', hint: '使用"连接配置（Connection Profile）"里保存的一套配置。' },
    { id: 'openai', label: 'OpenAI 兼容', hint: 'OpenAI、OpenRouter、中转站、本地 one-api/new-api 等，凡是 /chat/completions 都行。' },
    { id: 'anthropic', label: 'Claude（原生）', hint: 'Anthropic Messages 格式。自定义地址时密钥只能明文保存。' },
    { id: 'gemini', label: 'Gemini（原生）', hint: 'Google AI Studio 格式。自定义地址时密钥只能明文保存。' },
    { id: 'deepseek', label: 'DeepSeek 官方', hint: '官方地址，密钥进酒馆密钥库。' },
]);

export const CLAUDE_MODELS = Object.freeze([
    'claude-sonnet-5', 'claude-opus-5-5', 'claude-fable-5-1', 'claude-haiku-4-5-20251001',
    'claude-opus-4-8', 'claude-sonnet-4-6', 'claude-opus-4-7',
]);

export const SECRET_KEY_FOR = Object.freeze({
    openai: 'api_key_custom',
    anthropic: 'api_key_claude',
    gemini: 'api_key_makersuite',
    deepseek: 'api_key_deepseek',
});

function ctx() { return SillyTavern.getContext(); }

function headers() {
    return ctx().getRequestHeaders();
}

export function trimUrl(url) {
    return String(url || '').trim().replace(/\/+$/, '');
}

export function isOfficialUrl(provider, url) {
    const u = trimUrl(url);
    if (!u) return true;
    const official = OFFICIAL_URLS[provider];
    if (!official) return false;
    return trimUrl(official) === u || trimUrl(official).replace(/\/v1$/, '') === u.replace(/\/v1(beta)?$/, '');
}

/** 该连接是否必须明文保存密钥（ADR-0003 的例外）。 */
export function requiresInlineKey(conn) {
    return (conn.provider === 'anthropic' || conn.provider === 'gemini') && !isOfficialUrl(conn.provider, conn.baseUrl);
}

export function needsKey(conn) {
    return ['openai', 'anthropic', 'gemini', 'deepseek'].includes(conn.provider);
}

// ---------- 密钥库 ----------

export async function readSecretState() {
    const res = await fetch('/api/secrets/read', { method: 'POST', headers: headers() });
    if (!res.ok) throw new Error(`读取密钥状态失败（${res.status}）`);
    return await res.json();
}

async function rotateSecret(key, id) {
    await fetch('/api/secrets/rotate', { method: 'POST', headers: headers(), body: JSON.stringify({ key, id }) });
}

/**
 * 把密钥写入酒馆密钥库，返回 { id, label }。写入后把原先的活动密钥轮换回去，不打扰酒馆主界面。
 */
export async function storeKey(conn, value) {
    const key = SECRET_KEY_FOR[conn.provider];
    if (!key) throw new Error('该连接类型不需要密钥');
    const label = `PersonaArena · ${conn.name || conn.provider}`;
    let previousActive = null;
    try {
        const state = await readSecretState();
        previousActive = (state?.[key] || []).find(s => s.active)?.id || null;
    } catch { /* 忽略 */ }

    const res = await fetch('/api/secrets/write', {
        method: 'POST', headers: headers(), body: JSON.stringify({ key, value, label }),
    });
    if (!res.ok) throw new Error(`写入密钥失败（${res.status}）`);
    const { id } = await res.json();
    if (previousActive && previousActive !== id) {
        try { await rotateSecret(key, previousActive); } catch { /* 忽略 */ }
    }
    try { await ctx().eventSource.emit(ctx().event_types.SECRET_WRITTEN, key); } catch { /* 忽略 */ }
    return { id, label };
}

export async function deleteStoredKey(conn) {
    const key = SECRET_KEY_FOR[conn.provider];
    if (!key || !conn.secretId) return;
    try {
        await fetch('/api/secrets/delete', { method: 'POST', headers: headers(), body: JSON.stringify({ key, id: conn.secretId }) });
    } catch { /* 忽略 */ }
}

/** 密钥库里该 provider 已有的密钥（用于"复用酒馆已保存的密钥"）。 */
export async function listStoredKeys(provider) {
    const key = SECRET_KEY_FOR[provider];
    if (!key) return [];
    try {
        const state = await readSecretState();
        return (state?.[key] || []).map(s => ({ id: s.id, label: s.label || '（无标签）', masked: s.value, active: !!s.active }));
    } catch { return []; }
}

// ---------- 请求体 ----------

function sourceFor(provider) {
    switch (provider) {
        case 'openai': return 'custom';
        case 'anthropic': return 'claude';
        case 'gemini': return 'makersuite';
        case 'deepseek': return 'deepseek';
        default: return null;
    }
}

function parseHeaderLines(text) {
    const s = String(text || '').trim();
    return s ? s : '';
}

/** 生成 ChatCompletionService 需要的基础字段（不含 messages）。 */
export function basePayload(conn) {
    const c = ctx();
    if (conn.provider === 'st-current') {
        const s = c.chatCompletionSettings || {};
        const payload = {
            chat_completion_source: s.chat_completion_source,
            model: typeof c.getChatCompletionModel === 'function' ? c.getChatCompletionModel() : undefined,
            custom_url: s.custom_url || undefined,
            reverse_proxy: s.reverse_proxy || undefined,
            proxy_password: s.proxy_password || undefined,
            custom_include_headers: s.custom_include_headers || undefined,
        };
        if (conn.model) payload.model = conn.model;
        return payload;
    }
    const source = sourceFor(conn.provider);
    if (!source) throw new Error(`未知连接类型：${conn.provider}`);
    const payload = { chat_completion_source: source, model: conn.model };
    const url = trimUrl(conn.baseUrl);
    if (conn.provider === 'openai') {
        payload.custom_url = url || OFFICIAL_URLS.openai;
        const extra = parseHeaderLines(conn.extraHeaders);
        if (conn.keyMode === 'inline' && conn.inlineKey) {
            payload.custom_include_headers = `Authorization: Bearer ${conn.inlineKey}` + (extra ? `\n${extra}` : '');
        } else {
            if (conn.secretId) payload.secret_id = conn.secretId;
            if (extra) payload.custom_include_headers = extra;
        }
        return payload;
    }
    if (conn.provider === 'deepseek') {
        if (url && !isOfficialUrl('deepseek', url)) {
            payload.reverse_proxy = url;
            payload.proxy_password = conn.inlineKey || '';
        } else if (conn.keyMode === 'inline' && conn.inlineKey) {
            payload.reverse_proxy = OFFICIAL_URLS.deepseek;
            payload.proxy_password = conn.inlineKey;
        } else if (conn.secretId) {
            payload.secret_id = conn.secretId;
        }
        return payload;
    }
    // anthropic / gemini
    if (requiresInlineKey(conn)) {
        payload.reverse_proxy = url;
        payload.proxy_password = conn.inlineKey || '';
    } else if (conn.keyMode === 'inline' && conn.inlineKey) {
        payload.reverse_proxy = OFFICIAL_URLS[conn.provider];
        payload.proxy_password = conn.inlineKey;
    } else if (conn.secretId) {
        payload.secret_id = conn.secretId;
    }
    return payload;
}

// ---------- 模型列表 ----------

export async function listModels(conn) {
    if (conn.provider === 'anthropic') return [...CLAUDE_MODELS];
    if (conn.provider === 'st-profile') {
        const p = getProfile(conn.profileId);
        return p?.model ? [p.model] : [];
    }
    const payload = basePayload(conn);
    delete payload.model;
    const res = await fetch('/api/backends/chat-completions/status', {
        method: 'POST', headers: headers(), body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`拉取模型失败（${res.status}）`);
    const data = await res.json();
    if (data?.error && !data?.data) throw new Error('接口返回错误，请检查地址与密钥');
    const arr = Array.isArray(data) ? data : (data?.data?.data ?? data?.data ?? data?.models ?? []);
    const ids = arr.map(m => (typeof m === 'string' ? m : (m?.id ?? m?.name ?? ''))).filter(Boolean);
    return [...new Set(ids)].sort();
}

// ---------- 连接配置（Connection Profile） ----------

export function listProfiles() {
    const c = ctx();
    try {
        return c.ConnectionManagerRequestService?.getSupportedProfiles?.() ?? [];
    } catch { return []; }
}

export function getProfile(id) {
    return listProfiles().find(p => p.id === id) || null;
}

// ---------- 发送 ----------

/**
 * 发送一次对话补全。返回 { content, reasoning }。stream 时通过 onToken(cumulativeText) 回调。
 */
export async function sendChat(conn, messages, { maxTokens, temperature, signal, onToken, noJailbreak = false, task = 'roleplay' } = {}) {
    const c = ctx();
    // 破限默认只用于扮演类调用（行动/沙龙/私语）；工坊/罗盘/史官等要求 JSON 的任务默认不带，避免破限的"身份不动"指令压过格式要求。
    const applyJb = !noJailbreak && (task !== 'tool' || getSettings().jailbreak.applyToTools === true);
    messages = withJailbreak(messages, { skip: !applyJb });
    const stream = !!conn.stream && typeof onToken === 'function';
    const max_tokens = Number(maxTokens ?? conn.maxTokens ?? 800);
    const temp = temperature ?? conn.temperature;

    if (conn.provider === 'st-profile') {
        const svc = c.ConnectionManagerRequestService;
        if (!svc) throw new Error('酒馆的连接管理器不可用');
        if (!conn.profileId) throw new Error('未选择连接配置');
        // 不带连接配置里的预设（避免预设的采样/系统参数干扰），采样参数由这里给出
        const override = {};
        if (temp !== undefined && temp !== null && temp !== '') override.temperature = Number(temp);
        const result = await svc.sendRequest(conn.profileId, messages, max_tokens, { stream, signal, extractData: true, includePreset: false, includeInstruct: true }, override);
        return await consume(result, stream, onToken);
    }

    const svc = c.ChatCompletionService;
    if (!svc) {
        // 老版本降级：只能用当前连接
        const text = await c.generateRaw({ prompt: messages, quietToLoud: false });
        return { content: String(text || ''), reasoning: '' };
    }
    if (conn.provider === 'st-current' && c.mainApi && c.mainApi !== 'openai') {
        const text = await c.generateRaw({ prompt: messages, quietToLoud: false });
        return { content: String(text || ''), reasoning: '' };
    }

    const payload = {
        ...basePayload(conn),
        messages,
        max_tokens,
        stream,
    };
    if (temp !== undefined && temp !== null && temp !== '') payload.temperature = Number(temp);
    if (!payload.model) throw new Error('未填写模型名');

    const result = await svc.processRequest(payload, {}, true, signal);
    return await consume(result, stream, onToken);
}

async function consume(result, stream, onToken) {
    if (stream && typeof result === 'function') {
        let last = { text: '', state: {} };
        for await (const chunk of result()) {
            last = chunk;
            try { onToken(chunk.text); } catch { /* UI 错误不影响生成 */ }
        }
        return { content: String(last.text || ''), reasoning: String(last.state?.reasoning || '') };
    }
    if (result && typeof result === 'object') {
        return { content: String(result.content ?? ''), reasoning: String(result.reasoning ?? '') };
    }
    return { content: String(result ?? ''), reasoning: '' };
}

/** 快速连通性测试：发一句话，返回模型回复的前 80 字。 */
export async function testConnection(conn) {
    const { content } = await sendChat(
        { ...conn, stream: false },
        [{ role: 'user', content: '请只回复四个字：连接成功' }],
        { maxTokens: 32, noJailbreak: true, task: 'tool' },
    );
    return String(content || '').trim().slice(0, 80);
}

/** 找一个可用连接：优先指定 id，其次演员连接，最后第一个连接，再不行造一个 st-current。 */
export function resolveConnection(preferredId) {
    const s = getSettings();
    if (preferredId) {
        const c = s.connections.find(x => x.id === preferredId);
        if (c) return c;
    }
    if (s.connections[0]) return s.connections[0];
    return { id: '', name: '酒馆当前连接', provider: 'st-current', baseUrl: '', model: '', temperature: 0.9, maxTokens: 800, stream: true, keyMode: 'secret', secretId: '', inlineKey: '', extraHeaders: '' };
}

export function ensureDefaultConnection() {
    const s = getSettings();
    if (s.connections.length === 0) {
        s.connections.push({
            id: 'conn_default', name: '酒馆当前连接', provider: 'st-current', baseUrl: '', model: '', profileId: '',
            secretId: '', secretLabel: '', inlineKey: '', keyMode: 'secret', temperature: 0.9, maxTokens: 800, stream: true, extraHeaders: '',
        });
        saveSettings();
    }
}
