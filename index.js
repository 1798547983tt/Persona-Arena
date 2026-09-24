// Persona Arena · 人格竞技场 —— SillyTavern UI 扩展入口。
// 兼容路径：模块顶层初始化 + APP_READY 兜底（不依赖 manifest hooks，见 STDB/D5 §3.1）。

import { getSettings, saveSettings, MODULE_NAME } from './src/settings.js';
import { wireStageEvents } from './src/stage.js';
import { ensureDefaultConnection } from './src/connections.js';
import { createOrb } from './src/ui/orb.js';
import { createPanel } from './src/ui/panel.js';
import { onRoundChange, startRound, isRunning } from './src/rounds.js';
import { onSocialChange, isSocialBusy } from './src/social.js';
import { activeActors } from './src/state.js';
import { scheduleRecord } from './src/chronicler.js';
import { applyInjection, onFloorRendered } from './src/plot.js';
import { h, icon, toast } from './src/ui/dom.js';

const RUNTIME_KEY = '__PERSONA_ARENA_RUNTIME__';
let runtime = null;

function ctx() { return SillyTavern.getContext(); }

function addWandEntry(panel) {
    const menu = document.getElementById('extensionsMenu');
    if (!menu) return () => {};
    document.getElementById('persona-arena-wand')?.remove();
    const item = h('div', { id: 'persona-arena-wand', class: 'list-group-item flex-container flexGap5 interactable', tabindex: '0', title: '打开人格竞技场' },
        h('div', { class: 'fa-solid fa-masks-theater extensionsMenuExtensionButton' }),
        h('span', {}, '人格竞技场'),
    );
    item.addEventListener('click', () => panel.toggle());
    menu.appendChild(item);
    return () => item.remove();
}

function addSlashCommands(panel) {
    const c = ctx();
    const { SlashCommandParser, SlashCommand, SlashCommandArgument, ARGUMENT_TYPE } = c;
    if (!SlashCommandParser || !SlashCommand) return;
    try {
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'arena',
            callback: (_named, unnamed) => {
                const tab = String(unnamed || '').trim();
                if (tab === 'close') { panel.close(); return ''; }
                panel.open(['stage', 'plot', 'actors', 'salon', 'whisper', 'settings'].includes(tab) ? tab : undefined);
                return '';
            },
            unnamedArgumentList: [SlashCommandArgument.fromProps({ description: '页签：stage / plot / actors / salon / whisper / settings / close', typeList: [ARGUMENT_TYPE.STRING], isRequired: false })],
            helpString: '打开人格竞技场面板。',
        }));
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'arena-round',
            callback: async () => {
                try { const r = await startRound(); return `第 ${r.index} 回合完成`; } catch (err) { toast('error', err.message); return ''; }
            },
            helpString: '让全体演员出一手（相当于点击「开始下一回合」）。',
        }));
    } catch (err) {
        console.warn('[PersonaArena] slash command registration failed', err);
    }
}

function addSettingsDrawer(panel) {
    const host = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!host) return;
    document.getElementById('persona-arena-settings')?.remove();
    const openBtn = h('div', { class: 'menu_button menu_button_icon interactable', tabindex: '0' }, icon('masks-theater'), h('span', {}, '打开竞技场'));
    openBtn.addEventListener('click', () => panel.open());
    const orbToggle = h('input', { type: 'checkbox', id: 'persona-arena-orb-toggle' });
    orbToggle.checked = getSettings().ui.orbVisible !== false;
    orbToggle.addEventListener('change', () => { getSettings().ui.orbVisible = orbToggle.checked; saveSettings(); runtime?.orb?.show(orbToggle.checked); });
    host.appendChild(h('div', { id: 'persona-arena-settings', class: 'persona-arena-settings' },
        h('div', { class: 'inline-drawer' },
            h('div', { class: 'inline-drawer-toggle inline-drawer-header' }, h('b', {}, 'Persona Arena · 人格竞技场'), h('div', { class: 'inline-drawer-icon fa-solid fa-circle-chevron-down down' })),
            h('div', { class: 'inline-drawer-content' },
                h('div', { class: 'flex-container flexGap10 alignItemsCenter' }, openBtn, h('label', { class: 'checkbox_label', for: 'persona-arena-orb-toggle' }, orbToggle, h('span', {}, '显示悬浮球'))),
                h('small', {}, '所有设置都在竞技场面板的「设置」页里。斜杠命令：/arena [stage|plot|actors|salon|whisper|settings]、/arena-round。'),
            ),
        ),
    ));
}

function init() {
    if (runtime) return;
    const settings = getSettings();
    ensureDefaultConnection();
    wireStageEvents();

    const orb = createOrb({ onOpen: () => panel.toggle() });
    const panel = createPanel({ orb });
    panel.orb = orb;
    orb.show(settings.ui.orbVisible !== false);

    const disposers = [];
    disposers.push(addWandEntry(panel));
    addSlashCommands(panel);
    addSettingsDrawer(panel);

    // 悬浮球状态
    const refreshOrb = () => {
        orb.setBusy(isRunning() || isSocialBusy());
        const n = activeActors().length;
        orb.setBadge(n ? String(n) : '');
    };
    disposers.push(onRoundChange((round, d) => { refreshOrb(); if (d.finished && !panel.isOpen) toast('info', `第 ${round.index} 回合出手完毕，打开竞技场查看汇总`, '人格竞技场'); }));
    disposers.push(onSocialChange(() => refreshOrb()));
    refreshOrb();

    // 酒馆事件
    const { eventSource, event_types } = ctx();
    const onChatChanged = () => { refreshOrb(); applyInjection(); if (panel.isOpen) panel.refresh(); };
    const onMessageRendered = (messageId) => {
        refreshOrb();
        const s = getSettings();
        try { scheduleRecord(Number(messageId)); } catch (err) { console.warn('[PersonaArena] chronicler schedule failed', err); }
        try { onFloorRendered(); } catch (err) { console.warn('[PersonaArena] plot auto failed', err); }
        if (s.autoRoundOnReply && !isRunning() && activeActors().length && !panel.isOpen) {
            startRound().catch(err => toast('error', err.message));
        }
    };
    const onUserRendered = (messageId) => {
        try { scheduleRecord(Number(messageId), { isUser: true }); } catch { /* 忽略 */ }
    };
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, onMessageRendered);
    eventSource.on(event_types.USER_MESSAGE_RENDERED, onUserRendered);
    disposers.push(() => {
        eventSource.removeListener(event_types.CHAT_CHANGED, onChatChanged);
        eventSource.removeListener(event_types.CHARACTER_MESSAGE_RENDERED, onMessageRendered);
        eventSource.removeListener(event_types.USER_MESSAGE_RENDERED, onUserRendered);
    });
    applyInjection();

    // 魔棒菜单在某些版本会被重建，切聊天后补一次
    eventSource.on(event_types.CHAT_CHANGED, () => { if (!document.getElementById('persona-arena-wand')) disposers.push(addWandEntry(panel)); });

    runtime = {
        orb, panel,
        open: (tab, tabParams) => panel.open(tab, tabParams),
        destroy() {
            for (const d of disposers) { try { d?.(); } catch { /* 忽略 */ } }
            panel.destroy(); orb.destroy();
            document.getElementById('persona-arena-settings')?.remove();
            runtime = null;
        },
    };
    globalThis[RUNTIME_KEY]?.destroy?.();
    globalThis[RUNTIME_KEY] = runtime;
    globalThis.PersonaArena = runtime;
    console.info(`[PersonaArena] ready (${MODULE_NAME})`);
}

function boot() {
    try { init(); } catch (err) { console.error('[PersonaArena] init failed', err); }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
    boot();
}
try {
    const { eventSource, event_types } = ctx();
    eventSource.once(event_types.APP_READY, boot);
} catch { /* 忽略 */ }

// 供 1.17+ 的生命周期钩子使用（老版本忽略）
export async function onActivate() { boot(); }
export async function onDisable() { runtime?.destroy(); }
