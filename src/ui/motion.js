// 动效钩子：只负责"打标记"（data 属性、类名、CSS 变量），所有动画由 style.css 驱动。
// 没有 rAF、没有 JS 驱动的动画；面板隐藏时 display:none，CSS 动画自动停止。

/** 页签切换：把当前页签写到 root（强调色映射）与 tabs（滑动指示条 --pa-tab-i）。 */
export function markTab(root, tabsEl, tabs, currentTab) {
    root.dataset.tab = currentTab;
    tabsEl.style.setProperty('--pa-tab-i', String(Math.max(0, tabs.findIndex(t => t.id === currentTab))));
}

/**
 * 行动区标记：
 * - data-live：回合进行中，落款徽章（pa-seal）只在此时播放；
 * - data-settled：回合已落定，renderAll 重建卡片时不重播落墨（pa-ink）；
 * - data-drawn：本视图已画过一次，之后翻看往期回合不重播落墨。
 */
export function markMoves(movesEl, { live, settled } = {}) {
    if (live !== undefined) movesEl.toggleAttribute('data-live', !!live);
    if (settled === true) movesEl.dataset.settled = '1';
    else if (settled === false) delete movesEl.dataset.settled;
}

/** 行动区渲染前调用：非进行中且已画过 → 视为落定（不重播）；并记下已画过。 */
export function settleMovesIfRedrawn(movesEl, running) {
    if (!running && movesEl.dataset.drawn) movesEl.dataset.settled = '1';
    movesEl.dataset.drawn = '1';
}

/** 回合全部完成：底部金线扫过一次。 */
export function sweepComplete(movesEl, ms = 1400) {
    movesEl.classList.add('pa-moves-complete');
    setTimeout(() => movesEl.classList.remove('pa-moves-complete'), ms);
}

/** 悬浮球吸边落定：一次涟漪。reduced-motion 下无 animationend，用 setTimeout 兜底。 */
export function settlePulse(el) {
    el.classList.remove('pa-orb-settle');
    void el.offsetWidth; // 重启动画
    el.classList.add('pa-orb-settle');
    const off = () => el.classList.remove('pa-orb-settle');
    el.addEventListener('animationend', off, { once: true });
    setTimeout(off, 600);
}

/** 切到别的浏览器标签页时暂停悬浮球的循环动画；挂在元素自身而非 body。返回解绑函数。 */
export function pauseWhenHidden(el) {
    const onVis = () => el.classList.toggle('pa-orb-paused', !!document.hidden);
    document.addEventListener('visibilitychange', onVis);
    onVis();
    return () => document.removeEventListener('visibilitychange', onVis);
}
