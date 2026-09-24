// 竞技场面板外壳：窗口/抽屉两种形态、页签路由、打开关闭、主题。

import { h, add, clear, icon } from './dom.js';
import { getSettings } from '../settings.js';
import { renderStage } from './views/stage.js';
import { renderActors } from './views/actors.js';
import { renderSalon } from './views/salon.js';
import { renderWhisper } from './views/whisper.js';
import { renderSettings } from './views/settings.js';
import { markTab } from './motion.js';

const TABS = [
    { id: 'stage', label: '舞台', icon: 'masks-theater', render: renderStage },
    { id: 'actors', label: '演员', icon: 'user-astronaut', render: renderActors },
    { id: 'salon', label: '沙龙', icon: 'mug-hot', render: renderSalon },
    { id: 'whisper', label: '私语', icon: 'feather-pointed', render: renderWhisper },
    { id: 'settings', label: '设置', icon: 'sliders', render: renderSettings },
];

export function createPanel({ orb }) {
    let currentTab = 'stage';
    let opener = null;
    let viewCleanup = null;
    const params = {};

    const root = h('div', { id: 'persona-arena-root', class: 'pa-root', hidden: true });
    const backdrop = h('div', { class: 'pa-backdrop' });
    const viewEl = h('div', { class: 'pa-view' });
    const tabsEl = h('nav', { class: 'pa-tabs', role: 'tablist', 'aria-label': '竞技场页签' });
    const statusEl = h('div', { class: 'pa-status' });
    const closeBtn = h('button', { type: 'button', class: 'pa-close', 'aria-label': '关闭', onClick: () => api.close() }, icon('xmark'));
    const win = h('section', { class: 'pa-window', role: 'dialog', 'aria-modal': 'true', 'aria-label': '人格竞技场', tabindex: '-1' },
        h('header', { class: 'pa-header' },
            h('div', { class: 'pa-title' },
                h('span', { class: 'pa-title-glyph', 'aria-hidden': 'true' }, '戏'),
                h('div', { class: 'pa-title-text' },
                    h('h1', {}, '人格竞技场'),
                    h('span', { class: 'pa-subtitle' }, 'Persona Arena · 电子斗蛐蛐'),
                ),
            ),
            statusEl,
            closeBtn,
        ),
        h('main', { class: 'pa-body' }, viewEl),
        tabsEl,
    );
    add(root, backdrop, win);
    document.body.appendChild(root);

    backdrop.addEventListener('click', () => api.close());
    // Escape：面板打开且没有酒馆自己的模态框时关闭（不吞掉酒馆弹窗的 Escape）
    const onKeydown = (e) => {
        if (e.key !== 'Escape' || root.hidden) return;
        if (document.querySelector('dialog.popup[open]')) return;
        e.stopPropagation();
        api.close();
    };
    document.addEventListener('keydown', onKeydown, true);

    function applyTheme() {
        const s = getSettings();
        root.classList.toggle('pa-theme-ink', s.ui.theme !== 'paper');
        root.classList.toggle('pa-theme-paper', s.ui.theme === 'paper');
        const accent = s.ui.accent || '#d4482f';
        root.style.setProperty('--pa-accent', accent);
        orb?.el?.style.setProperty('--pa-accent', accent);
        root.style.setProperty('--pa-font-scale', String(s.ui.fontScale || 1));
        const shell = s.ui.shell || 'auto';
        const narrow = window.matchMedia('(max-width: 1000px)').matches || window.matchMedia('(pointer: coarse) and (max-width: 1200px)').matches;
        const mode = shell === 'auto' ? (narrow ? 'sheet' : 'window') : shell;
        root.dataset.shell = mode;
    }

    function renderTabs() {
        clear(tabsEl);
        for (const t of TABS) {
            const b = h('button', {
                type: 'button', role: 'tab', class: `pa-tab ${t.id === currentTab ? 'active' : ''}`, dataset: { tab: t.id },
                'aria-selected': t.id === currentTab ? 'true' : 'false',
                onClick: () => api.openTab(t.id),
            }, icon(t.icon), h('span', {}, t.label));
            add(tabsEl, b);
        }
        markTab(root, tabsEl, TABS, currentTab);
    }

    function renderView() {
        if (typeof viewCleanup === 'function') { try { viewCleanup(); } catch { /* 忽略 */ } }
        viewCleanup = null;
        clear(viewEl);
        const tab = TABS.find(t => t.id === currentTab) || TABS[0];
        viewEl.dataset.tab = tab.id;
        try {
            viewCleanup = tab.render(viewEl, api, params[tab.id] || {}) || null;
        } catch (err) {
            console.error('[PersonaArena] view render failed', err);
            add(viewEl, h('div', { class: 'pa-empty' }, `页面渲染失败：${err.message}`));
        }
        viewEl.scrollTop = 0;
    }

    const api = {
        root,
        get isOpen() { return !root.hidden; },
        get currentTab() { return currentTab; },
        open(tab, tabParams) {
            opener = document.activeElement;
            applyTheme();
            if (tab) { currentTab = tab; params[tab] = tabParams || {}; }
            root.hidden = false;
            requestAnimationFrame(() => root.classList.add('pa-open'));
            renderTabs();
            renderView();
            setTimeout(() => win.focus(), 30);
        },
        close() {
            if (root.hidden) return;
            root.classList.remove('pa-open');
            const done = () => {
                root.hidden = true;
                if (typeof viewCleanup === 'function') { try { viewCleanup(); } catch { /* 忽略 */ } }
                viewCleanup = null;
                clear(viewEl);
                try { (opener instanceof HTMLElement ? opener : orb?.el)?.focus?.(); } catch { /* 忽略 */ }
            };
            if (document.body.classList.contains('reduced-motion') || window.matchMedia('(prefers-reduced-motion: reduce)').matches) done();
            else setTimeout(done, 180);
        },
        toggle() { root.hidden ? api.open() : api.close(); },
        openTab(id, tabParams) {
            if (!TABS.some(t => t.id === id)) return;
            currentTab = id;
            if (tabParams) params[id] = tabParams;
            renderTabs();
            renderView();
        },
        refresh() { if (!root.hidden) { applyTheme(); renderView(); } },
        applyTheme,
        setStatus(text, kind = '') {
            clear(statusEl);
            statusEl.className = `pa-status ${kind}`.trim();
            if (text) add(statusEl, h('span', { class: 'pa-status-dot' }), h('span', {}, text));
        },
        destroy() {
            if (typeof viewCleanup === 'function') { try { viewCleanup(); } catch { /* 忽略 */ } }
            document.removeEventListener('keydown', onKeydown, true);
            root.remove();
        },
    };

    window.addEventListener('resize', () => { if (!root.hidden) applyTheme(); });
    return api;
}
