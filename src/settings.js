// 全局设置：演员、连接、偏好。存在 extension_settings['persona-arena']。
// 密钥不在这里（见 docs/adr/0003）。

export const MODULE_NAME = 'persona-arena';
export const SETTINGS_VERSION = 1;

export const DEFAULT_CONNECTION = Object.freeze({
    id: '',
    name: '',
    provider: 'st-current',   // st-current | st-profile | openai | anthropic | gemini | deepseek
    baseUrl: '',
    model: '',
    profileId: '',
    secretId: '',
    secretLabel: '',
    inlineKey: '',            // 仅在 keyMode === 'inline' 时使用（ADR-0003 的例外）
    keyMode: 'secret',        // secret | inline
    temperature: 0.9,
    maxTokens: 800,
    stream: true,
    extraHeaders: '',         // YAML/一行一个 "Header: value"，仅 openai 兼容
});

export const DEFAULT_ACTOR = Object.freeze({
    id: '',
    name: '',
    emoji: '🎭',
    color: '#c8553d',
    connectionId: '',
    enabled: true,
    sheet: {
        origin: 'original',   // original | story | crossover
        source: '',           // 同人来源作品
        presetId: '',
        personality: '',
        appearance: '',
        backstory: '',
        voice: '',
        bottomLines: '',
        goals: '',
        abilities: '',        // 能力（一行一条）
    },
    promptOverride: '',       // 高级：完全替换行动系统提示
});

export const DEFAULT_SETTINGS = Object.freeze({
    version: SETTINGS_VERSION,
    enabled: true,
    language: 'zh',
    contextFloors: 5,
    includeWorldInfo: true,
    includeCharacterCard: false,
    includeSalonDigest: true,
    roundMode: 'sequential',  // sequential | parallel
    moveMaxChars: 220,
    autoSend: false,
    autoRoundOnReply: false,
    dispatchTemplate: '【{{name}}】\n{{move}}',
    dispatchSeparator: '\n\n',
    dispatchPrefix: '',
    dispatchSuffix: '',
    salonAutoTurns: 2,
    bondImportantThreshold: 60,
    search: {
        provider: 'auto',     // auto | tavily | serper | searxng | duckduckgo | off
        searxngUrl: '',
        maxResults: 5,
    },
    workshopConnectionId: '', // 生成人设用的连接；空 = 演员自己的连接或第一个
    ui: {
        theme: 'ink',         // ink | paper
        accent: '#c8553d',
        shell: 'auto',        // auto | window | sheet
        orbVisible: true,
        fontScale: 1,
    },
    jailbreak: {
        enabled: false,       // 玩家自己开关
        applyToTools: false,  // 工坊/罗盘/史官（要求 JSON 的任务）是否也带破限
        source: 'bundled',    // bundled | custom
        bundledOn: {},        // 内置条目开关覆盖 { id: bool }
        custom: [],           // 从自己预设提取的条目 [{ id, name, content, on }]
        customName: '',
    },
    plot: {
        autoEveryFloors: 0,   // 0 = 手动；N = 每 N 层自动推演
        contextFloors: 12,    // 推演时读最近几层正文
        injectEnabled: true,  // 把罗盘引导注入正文提示词
        injectDepth: 1,
        injectRole: 0,        // 0 system / 1 user / 2 assistant
        feedActors: true,     // 演员行动时也能看到走向
        chunkChars: 6000,
        digestMaxChars: 5000,
        connectionId: '',     // 空 = 工坊连接
    },
    chronicler: {
        enabled: false,
        connectionId: '',     // 主 AI（史官）用哪套连接；空 = 工坊连接
        trigger: 'ai',        // ai | all | manual
        minChars: 40,
        fields: { mood: true, goal: true, bonds: true, chronicle: true, sheet: true, abilities: true, npcs: true },
        maxLog: 20,
    },
    canons: [],               // 原著摘要 [{ id, name, sourceType, digest, chapters, chars, createdAt }]
    connections: [],
    actors: [],
});

let cachedContext = null;
function ctx() {
    if (!cachedContext) cachedContext = SillyTavern.getContext();
    return cachedContext;
}

function deepMerge(base, patch) {
    if (Array.isArray(base)) return Array.isArray(patch) ? patch : base;
    if (base && typeof base === 'object') {
        const out = { ...base };
        if (patch && typeof patch === 'object') {
            for (const key of Object.keys(patch)) {
                out[key] = key in base ? deepMerge(base[key], patch[key]) : patch[key];
            }
        }
        return out;
    }
    return patch === undefined ? base : patch;
}

export function getSettings() {
    const { extensionSettings } = ctx();
    if (!extensionSettings[MODULE_NAME]) {
        extensionSettings[MODULE_NAME] = structuredClone(DEFAULT_SETTINGS);
    }
    const merged = deepMerge(structuredClone(DEFAULT_SETTINGS), extensionSettings[MODULE_NAME]);
    merged.connections = (merged.connections || []).map(c => deepMerge(structuredClone(DEFAULT_CONNECTION), c));
    merged.actors = (merged.actors || []).map(a => deepMerge(structuredClone(DEFAULT_ACTOR), a));
    extensionSettings[MODULE_NAME] = merged;
    return merged;
}

export function saveSettings() {
    ctx().saveSettingsDebounced();
}

export function uid(prefix = 'pa') {
    const c = ctx();
    const raw = typeof c.uuidv4 === 'function' ? c.uuidv4() : Math.random().toString(36).slice(2) + Date.now().toString(36);
    return `${prefix}_${raw.replace(/-/g, '').slice(0, 12)}`;
}

export function getConnection(id) {
    return getSettings().connections.find(c => c.id === id) || null;
}

export function getActor(id) {
    return getSettings().actors.find(a => a.id === id) || null;
}

export function upsertConnection(conn) {
    const s = getSettings();
    if (!conn.id) conn.id = uid('conn');
    const idx = s.connections.findIndex(c => c.id === conn.id);
    if (idx >= 0) s.connections[idx] = conn; else s.connections.push(conn);
    saveSettings();
    return conn;
}

export function removeConnection(id) {
    const s = getSettings();
    s.connections = s.connections.filter(c => c.id !== id);
    for (const a of s.actors) if (a.connectionId === id) a.connectionId = '';
    saveSettings();
}

export function upsertActor(actor) {
    const s = getSettings();
    if (!actor.id) actor.id = uid('actor');
    const idx = s.actors.findIndex(a => a.id === actor.id);
    if (idx >= 0) s.actors[idx] = actor; else s.actors.push(actor);
    saveSettings();
    return actor;
}

export function removeActor(id) {
    const s = getSettings();
    s.actors = s.actors.filter(a => a.id !== id);
    saveSettings();
}

export function moveActor(id, delta) {
    const s = getSettings();
    const idx = s.actors.findIndex(a => a.id === id);
    const target = idx + delta;
    if (idx < 0 || target < 0 || target >= s.actors.length) return;
    const [a] = s.actors.splice(idx, 1);
    s.actors.splice(target, 0, a);
    saveSettings();
}

export function getCanon(id) {
    return getSettings().canons.find(c => c.id === id) || null;
}

export function upsertCanon(canon) {
    const s = getSettings();
    if (!canon.id) canon.id = uid('canon');
    const idx = s.canons.findIndex(c => c.id === canon.id);
    if (idx >= 0) s.canons[idx] = canon; else s.canons.push(canon);
    saveSettings();
    return canon;
}

export function removeCanon(id) {
    const s = getSettings();
    s.canons = s.canons.filter(c => c.id !== id);
    saveSettings();
}

export function exportSettings() {
    const s = structuredClone(getSettings());
    for (const c of s.connections) { c.inlineKey = ''; }
    return JSON.stringify(s, null, 2);
}

export function importSettings(json) {
    const parsed = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object') throw new Error('无效的设置文件');
    const { extensionSettings } = ctx();
    extensionSettings[MODULE_NAME] = deepMerge(structuredClone(DEFAULT_SETTINGS), parsed);
    saveSettings();
    return getSettings();
}
