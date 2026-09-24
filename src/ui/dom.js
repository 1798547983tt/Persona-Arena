// 极简 DOM 工具：h() 建元素、安全文本、轻量 Markdown。

export function h(tag, props = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'style' && typeof v === 'object') { for (const [sk, sv] of Object.entries(v)) { if (sk.startsWith('--')) el.style.setProperty(sk, sv); else el.style[sk] = sv; } }
        else if (k === 'dataset') Object.assign(el.dataset, v);
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
        else if (k === 'html') el.innerHTML = sanitize(v);
        else if (k === 'value') el.value = String(v);
        else if (k in el && typeof v !== 'string') el[k] = v;
        else el.setAttribute(k, v === true ? '' : String(v));
    }
    append(el, children);
    return el;
}

export function append(el, children) {
    for (const c of children.flat(Infinity)) {
        if (c === null || c === undefined || c === false) continue;
        el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
}

/** 安全 append：跳过 null/false，数组自动展开（原生 append 会把 null 变成文本 "null"）。 */
export function add(el, ...children) {
    return append(el, children);
}

export function clear(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
    return el;
}

export function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

export function sanitize(html) {
    const { DOMPurify } = SillyTavern.libs || {};
    if (DOMPurify) return DOMPurify.sanitize(html, { USE_PROFILES: { html: true }, FORBID_TAGS: ['style', 'script', 'iframe', 'form', 'input', 'button'], FORBID_ATTR: ['onerror', 'onload', 'onclick', 'style'] });
    return escapeHtml(html);
}

/** 轻量 Markdown：*斜体*、**粗体**、“引号”高亮、换行。不用 showdown，避免把奇怪标签渲染出来。 */
export function renderRich(text) {
    let s = escapeHtml(text);
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
    s = s.replace(/(“[^”\n]{1,200}”|"[^"\n]{1,200}"|「[^」\n]{1,200}」)/g, '<q>$1</q>');
    s = s.replace(/\n/g, '<br>');
    return h('div', { class: 'pa-rich', html: s });
}

export function icon(name, extra = '') {
    return h('i', { class: `fa-solid fa-${name} ${extra}`.trim(), 'aria-hidden': 'true' });
}

export function button(label, { icon: ic, onClick, kind = '', title, disabled } = {}) {
    const b = h('button', { type: 'button', class: `pa-btn ${kind}`.trim(), title: title || null, onClick, disabled: !!disabled },
        ic ? icon(ic) : null, label ? h('span', {}, label) : null);
    return b;
}

export function field(label, control, hint) {
    return h('label', { class: 'pa-field' },
        h('span', { class: 'pa-field-label' }, label),
        control,
        hint ? h('span', { class: 'pa-field-hint' }, hint) : null,
    );
}

export function input(props = {}) {
    return h('input', { type: 'text', class: 'pa-input', ...props });
}

export function textarea(props = {}) {
    return h('textarea', { class: 'pa-input pa-textarea', rows: 3, ...props });
}

export function select(options, props = {}) {
    const sel = h('select', { class: 'pa-input pa-select', ...props });
    for (const o of options) {
        const opt = h('option', { value: o.value }, o.label);
        if (o.value === props.value) opt.selected = true;
        sel.append(opt);
    }
    return sel;
}

export function toggle(checked, onChange, label) {
    const box = h('input', { type: 'checkbox', class: 'pa-toggle-input' });
    box.checked = !!checked;
    box.addEventListener('change', () => onChange(box.checked));
    return h('label', { class: 'pa-toggle' }, box, h('span', { class: 'pa-toggle-track' }, h('span', { class: 'pa-toggle-thumb' })), label ? h('span', { class: 'pa-toggle-label' }, label) : null);
}

export function toast(kind, text, title) {
    try {
        if (window.toastr) { window.toastr[kind]?.(text, title); return; }
    } catch { /* 忽略 */ }
    console[kind === 'error' ? 'error' : 'log']('[PersonaArena]', title || '', text);
}

export function fmtTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const pad = n => String(n).padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export async function confirmDialog(title, text) {
    try {
        const { Popup, POPUP_RESULT } = SillyTavern.getContext();
        const r = await Popup.show.confirm(title, text);
        return r === POPUP_RESULT.AFFIRMATIVE;
    } catch {
        return window.confirm(`${title}\n${text || ''}`);
    }
}

export async function promptDialog(title, text, defaultValue = '') {
    try {
        const { Popup } = SillyTavern.getContext();
        return await Popup.show.input(title, text, defaultValue);
    } catch {
        return window.prompt(`${title}\n${text || ''}`, defaultValue);
    }
}

/** 一个小的可展开区块 */
export function collapsible(title, contentEl, { open = false } = {}) {
    const det = h('details', { class: 'pa-collapsible' }, h('summary', {}, title), contentEl);
    det.open = open;
    return det;
}

export function avatarBadge(actor, size = 'md') {
    return h('span', { class: `pa-avatar pa-avatar-${size}`, style: { '--pa-actor': actor?.color || '#d4482f' } }, actor?.emoji || '🎭');
}
