// 悬浮球：Pointer Events、拖动/点击仲裁、吸边、归一化坐标持久化、长按半隐。参考 STDB/C11。

const STORAGE_KEY = 'persona-arena:orb-placement';
const STORAGE_VERSION = 1;
const DRAG_THRESHOLD = 6;
const LONG_PRESS_MS = 550;
const SIZE = 56;

function viewport() {
    const vv = window.visualViewport;
    return vv ? { x: vv.offsetLeft, y: vv.offsetTop, w: vv.width, h: vv.height } : { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight };
}

function loadPlacement() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return null;
        const p = JSON.parse(raw);
        if (p?.version !== STORAGE_VERSION) return null;
        const fx = Math.min(1, Math.max(0, Number(p.fx)));
        const fy = Math.min(1, Math.max(0, Number(p.fy)));
        if (!Number.isFinite(fx) || !Number.isFinite(fy)) return null;
        return { fx, fy, docked: p.docked !== false, side: p.side === 'left' ? 'left' : 'right', hidden: !!p.hidden };
    } catch { return null; }
}

function savePlacement(p) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: STORAGE_VERSION, ...p })); } catch { /* 忽略 */ }
}

export function createOrb({ onOpen }) {
    const el = document.createElement('button');
    el.id = 'persona-arena-orb';
    el.type = 'button';
    el.className = 'pa-orb';
    el.setAttribute('aria-label', '打开人格竞技场');
    el.title = '人格竞技场 · 点击打开，拖动移动，长按收纳';
    el.innerHTML = '<span class="pa-orb-halo"></span><span class="pa-orb-core"><span class="pa-orb-glyph">戏</span></span><span class="pa-orb-badge" hidden></span>';

    const state = loadPlacement() || { fx: 0.94, fy: 0.62, docked: true, side: 'right', hidden: false };
    let gesture = null;
    let longPressTimer = null;
    let rafId = 0;
    let pos = { x: 0, y: 0 };

    function applyState(animate = true) {
        const vp = viewport();
        const margin = 8;
        let x = vp.x + state.fx * (vp.w - SIZE);
        let y = vp.y + state.fy * (vp.h - SIZE);
        y = Math.min(vp.y + vp.h - SIZE - margin, Math.max(vp.y + margin, y));
        if (state.docked) {
            x = state.side === 'left' ? vp.x + margin : vp.x + vp.w - SIZE - margin;
            if (state.hidden) x += state.side === 'left' ? -SIZE * 0.55 : SIZE * 0.55;
        } else {
            x = Math.min(vp.x + vp.w - SIZE - margin, Math.max(vp.x + margin, x));
        }
        el.classList.toggle('pa-orb-animate', animate);
        el.classList.toggle('pa-orb-hidden', !!state.hidden);
        el.dataset.side = state.side;
        setPos(x, y);
    }

    function setPos(x, y) {
        pos = { x, y };
        el.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
    }

    function settle() {
        const vp = viewport();
        const cx = pos.x + SIZE / 2;
        state.fx = Math.min(1, Math.max(0, (pos.x - vp.x) / Math.max(1, vp.w - SIZE)));
        state.fy = Math.min(1, Math.max(0, (pos.y - vp.y) / Math.max(1, vp.h - SIZE)));
        const nearLeft = cx - vp.x < vp.w * 0.28;
        const nearRight = vp.x + vp.w - cx < vp.w * 0.28;
        state.docked = nearLeft || nearRight;
        if (state.docked) state.side = nearLeft ? 'left' : 'right';
        state.hidden = false;
        savePlacement(state);
        applyState(true);
    }

    function clearLongPress() { clearTimeout(longPressTimer); longPressTimer = null; }

    el.addEventListener('pointerdown', (e) => {
        if (!e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return;
        if (gesture) return;
        try { el.setPointerCapture(e.pointerId); } catch { /* 忽略 */ }
        gesture = { id: e.pointerId, sx: e.clientX, sy: e.clientY, ox: pos.x, oy: pos.y, dragging: false };
        el.classList.add('pa-orb-pressed');
        clearLongPress();
        if (state.docked) {
            longPressTimer = setTimeout(() => {
                if (gesture && !gesture.dragging) {
                    state.hidden = !state.hidden;
                    savePlacement(state);
                    applyState(true);
                    gesture.consumed = true;
                }
            }, LONG_PRESS_MS);
        }
    });

    el.addEventListener('pointermove', (e) => {
        if (!gesture || e.pointerId !== gesture.id) return;
        const dx = e.clientX - gesture.sx;
        const dy = e.clientY - gesture.sy;
        if (!gesture.dragging && Math.hypot(dx, dy) > DRAG_THRESHOLD) {
            gesture.dragging = true;
            clearLongPress();
            el.classList.remove('pa-orb-animate');
            el.classList.add('pa-orb-dragging');
        }
        if (gesture.dragging) {
            cancelAnimationFrame(rafId);
            rafId = requestAnimationFrame(() => setPos(gesture.ox + dx, gesture.oy + dy));
        }
    });

    function finish(e, cancelled) {
        if (!gesture || e.pointerId !== gesture.id) return;
        const g = gesture;
        gesture = null;
        clearLongPress();
        cancelAnimationFrame(rafId);
        el.classList.remove('pa-orb-pressed', 'pa-orb-dragging');
        try { el.releasePointerCapture(e.pointerId); } catch { /* 忽略 */ }
        if (cancelled) { applyState(true); return; }
        if (g.dragging) { settle(); return; }
        if (g.consumed) return;
        if (state.hidden) { state.hidden = false; savePlacement(state); applyState(true); return; }
        onOpen?.();
    }
    el.addEventListener('pointerup', (e) => finish(e, false));
    el.addEventListener('pointercancel', (e) => finish(e, true));
    el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen?.(); }
    });

    const onResize = () => applyState(false);
    window.addEventListener('resize', onResize);
    window.visualViewport?.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', () => setTimeout(onResize, 300));

    document.body.appendChild(el);
    applyState(false);
    requestAnimationFrame(() => el.classList.add('pa-orb-mounted'));

    return {
        el,
        setBadge(text) {
            const b = el.querySelector('.pa-orb-badge');
            if (!b) return;
            if (text) { b.textContent = text; b.hidden = false; } else { b.hidden = true; }
        },
        setBusy(v) { el.classList.toggle('pa-orb-busy', !!v); },
        show(v) { el.style.display = v ? '' : 'none'; },
        resetPosition() {
            Object.assign(state, { fx: 0.94, fy: 0.62, docked: true, side: 'right', hidden: false });
            savePlacement(state);
            applyState(true);
        },
        destroy() {
            window.removeEventListener('resize', onResize);
            window.visualViewport?.removeEventListener('resize', onResize);
            el.remove();
        },
    };
}
