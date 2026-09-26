/* Promotional Content Hub — shared client code */
(function () {
  'use strict';

  const ICONS = {
    bell: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>',
    menu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 6h16M4 12h16M4 18h16"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
    download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12m0 0l-4-4m4 4l4-4M4 21h16"/></svg>',
  };

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  async function api(method, url, body) {
    const opts = { method, headers: { 'X-Requested-With': 'PromoHub' }, credentials: 'same-origin' };
    if (body instanceof FormData) opts.body = body;
    else if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    let res;
    try { res = await fetch(url, opts); } catch (e) { throw new Error('Network error — are you offline?'); }
    let data = null;
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) data = await res.json();
    if (res.status === 401 && !url.startsWith('/api/auth/')) {
      location.href = '/login';
      throw new Error('Session expired');
    }
    if (res.status === 403 && data && data.twofaSetupRequired) {
      location.href = '/profile?setup2fa=1';
      throw new Error('2FA setup required');
    }
    if (res.status === 403 && data && data.mustChangePassword) {
      location.href = '/profile?force=1';
      throw new Error('Password change required');
    }
    if (!res.ok) {
      const err = new Error((data && data.error) || `Request failed (${res.status})`);
      err.status = res.status; err.data = data;
      throw err;
    }
    return data;
  }

  function toast(msg, type) {
    let box = document.getElementById('toasts');
    if (!box) { box = document.createElement('div'); box.id = 'toasts'; document.body.appendChild(box); }
    const t = document.createElement('div');
    t.className = `toast ${type || 'ok'}`;
    t.textContent = msg;
    box.appendChild(t);
    setTimeout(() => t.remove(), type === 'err' ? 6000 : 3200);
  }

  const pad = (n) => String(n).padStart(2, '0');
  function fmtDate(d) {
    if (!d) return '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(d)) {
      const [y, m, day] = d.split('-').map(Number);
      return new Date(y, m - 1, day).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    }
    return new Date(d).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }
  function fmtDateTime(d) {
    if (!d) return '';
    return new Date(d).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  function ago(d) {
    const s = Math.round((Date.now() - new Date(d).getTime()) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    if (s < 604800) return `${Math.floor(s / 86400)}d ago`;
    return fmtDate(d);
  }
  function today() { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }

  const PILL = {
    'New': 's-new', 'Pending Approval': 's-pending', 'Pending': 's-pending', 'Approved': 's-approved', 'Rejected': 's-rejected',
    'Not Started': 's-notstarted', 'In Progress': 's-progress', 'On Hold': 's-hold', 'Done': 's-done',
    'Low': 's-low', 'Normal': 's-normal', 'High': 's-high', 'Urgent': 's-urgent',
  };
  const pill = (s) => `<span class="pill ${PILL[s] || 's-normal'}">${esc(s)}</span>`;
  const initials = (name) => String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('');

  // ---------- Modal ----------
  function modal({ title, body, foot, size, onClose }) {
    const bd = document.createElement('div');
    bd.className = 'modal-backdrop';
    bd.innerHTML = `<div class="modal ${size || ''}" role="dialog" aria-modal="true">
      <div class="modal-head"><h2>${esc(title)}</h2><button class="iconbtn" data-close aria-label="Close">${ICONS.close}</button></div>
      <div class="modal-body"></div>
      ${foot !== false ? '<div class="modal-foot"></div>' : ''}
    </div>`;
    const bodyEl = bd.querySelector('.modal-body');
    if (typeof body === 'string') bodyEl.innerHTML = body; else if (body) bodyEl.appendChild(body);
    const footEl = bd.querySelector('.modal-foot');
    if (footEl && foot) footEl.innerHTML = foot;
    const close = () => { bd.remove(); document.removeEventListener('keydown', onKey); if (onClose) onClose(); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    bd.addEventListener('mousedown', (e) => { if (e.target === bd) close(); });
    bd.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close));
    document.body.appendChild(bd);
    const first = bd.querySelector('input:not([type=hidden]), select, textarea');
    if (first) setTimeout(() => first.focus(), 30);
    return { el: bd, body: bodyEl, foot: footEl, close };
  }

  function confirmDialog(title, message, { okText = 'Confirm', danger = false, input = null } = {}) {
    return new Promise((resolve) => {
      let done = false;
      const inputHtml = input
        ? `<label class="f mt-12"><span>${esc(input.label)}${input.required ? ' <span class="req">*</span>' : ''}</span><textarea id="cd-input" maxlength="2000"></textarea></label>` : '';
      const m = modal({
        title, size: 'sm',
        body: `<p class="muted m-0">${esc(message)}</p>${inputHtml}`,
        foot: `<button class="btn" data-close>Cancel</button><button class="btn ${danger ? 'danger' : 'primary'}" id="cd-ok">${esc(okText)}</button>`,
        onClose: () => { if (!done) resolve(null); },
      });
      m.el.querySelector('#cd-ok').addEventListener('click', () => {
        const val = input ? m.el.querySelector('#cd-input').value.trim() : true;
        if (input && input.required && !val) { toast(`${input.label} is required`, 'err'); return; }
        done = true; m.close(); resolve(input ? { value: val } : true);
      });
    });
  }

  function formData(form) {
    const out = {};
    new FormData(form).forEach((v, k) => { out[k] = typeof v === 'string' ? v : v; });
    form.querySelectorAll('input[type=checkbox][name]').forEach((c) => { out[c.name] = c.checked; });
    return out;
  }

  function options(list, selected, { blank } = {}) {
    let html = blank !== undefined ? `<option value="">${esc(blank)}</option>` : '';
    for (const o of list) {
      const val = typeof o === 'object' ? o.value : o;
      const label = typeof o === 'object' ? o.label : o;
      html += `<option value="${esc(val)}"${String(val) === String(selected ?? '') ? ' selected' : ''}>${esc(label)}</option>`;
    }
    return html;
  }

  function download(filename, text, type) {
    const blob = new Blob([text], { type: type || 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  // ---------- Theme (palette = Admin, per site) + Appearance (dark/light/system = per user) ----------
  const theme = { name: 'midnight', accent: '', mode: 'system' };
  const mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;

  function wcagContrast(hex) {
    const ch = (i) => { const c = parseInt(hex.slice(i, i + 2), 16) / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
    const L = 0.2126 * ch(1) + 0.7152 * ch(3) + 0.0722 * ch(5);
    const white = 1.05 / (L + 0.05); const dark = (L + 0.05) / 0.0561; // vs #ffffff and ~#0b0e14
    return white >= dark ? '#ffffff' : '#0b0e14';
  }
  function resolvedMode() {
    if (theme.mode === 'dark' || theme.mode === 'light') return theme.mode;
    return mq && mq.matches ? 'light' : 'dark';
  }
  function applyTheme() {
    const d = document.documentElement;
    d.setAttribute('data-theme', theme.name);
    d.setAttribute('data-mode', resolvedMode());
    const custom = /^#[0-9a-f]{6}$/i.test(theme.accent || '') ? theme.accent : '';
    if (custom) {
      d.style.setProperty('--accent', custom);
      d.style.setProperty('--accent-contrast', wcagContrast(custom));
    } else {
      d.style.removeProperty('--accent');
      d.style.removeProperty('--accent-contrast');
    }
    requestAnimationFrame(() => {
      const meta = document.querySelector('meta[name=theme-color]');
      if (meta && document.body) meta.setAttribute('content', getComputedStyle(document.body).backgroundColor);
    });
    try {
      localStorage.setItem('phub-theme', JSON.stringify({
        theme: theme.name, mode: theme.mode, accent: custom, contrast: custom ? wcagContrast(custom) : '',
      }));
    } catch (_) { /* storage unavailable — theme-boot just falls back to defaults */ }
  }
  if (mq) {
    const onChange = () => { if (theme.mode === 'system') applyTheme(); };
    if (mq.addEventListener) mq.addEventListener('change', onChange); else if (mq.addListener) mq.addListener(onChange);
  }
  function cachedMode() {
    try { const c = JSON.parse(localStorage.getItem('phub-theme') || '{}'); return c.mode || 'system'; } catch (_) { return 'system'; }
  }
  /** Admin live preview (not saved) */
  function previewTheme(name, accent) {
    if (name) theme.name = name;
    theme.accent = accent || '';
    applyTheme();
  }
  /** User appearance: saved to their account */
  async function setAppearance(mode) {
    theme.mode = mode;
    applyTheme();
    document.querySelectorAll('[data-appearance]').forEach((b) => b.classList.toggle('on', b.dataset.appearance === mode));
    await api('PUT', '/api/profile/appearance', { mode });
  }
  const APPEARANCE_OPTS = [['dark', 'Dark'], ['light', 'Light'], ['system', 'System']];
  const appearanceSeg = () => `<div class="segmented mode-seg">${APPEARANCE_OPTS.map(([k, l]) =>
    `<button type="button" data-appearance="${k}" class="${theme.mode === k ? 'on' : ''}">${l}</button>`).join('')}</div>`;
  function bindAppearance(root) {
    root.querySelectorAll('[data-appearance]').forEach((b) => b.addEventListener('click', async (e) => {
      e.stopPropagation();
      try { await setAppearance(b.dataset.appearance); } catch (err) { toast(err.message, 'err'); }
    }));
  }

  // ---------- Branding ----------
  let branding = null;
  async function loadBranding() {
    if (branding) return branding;
    try { branding = await api('GET', '/api/branding'); } catch (e) { branding = { app_name: 'Promotional Content Hub', theme: 'midnight', accent_color: '' }; }
    theme.name = branding.theme || 'midnight';
    theme.accent = branding.accent_color || '';
    theme.mode = cachedMode();
    applyTheme();
    return branding;
  }
  function brandHtml(b) {
    const logo = b.logo_url
      ? `<img src="${esc(b.logo_url)}" alt="">`
      : `<span class="mark">${esc(initials(b.app_name).slice(0, 2) || 'P')}</span>`;
    return `${logo}<span class="name">${esc(b.app_name)}</span>`;
  }

  // ---------- Top nav ----------
  function renderNav(ctx, current) {
    const nav = document.getElementById('topnav');
    if (!nav) return;
    const u = ctx.user;
    const links = ctx.pages.filter((p) => p.inNav !== false)
      .map((p) => `<a href="${p.path}" class="${p.path === current ? 'active' : ''}">${esc(p.label)}</a>`).join('');
    nav.innerHTML = `
      <button class="iconbtn menu-toggle" id="nav-toggle" aria-label="Menu">${ICONS.menu}</button>
      <a class="brand" href="/">${brandHtml(ctx.branding)}</a>
      <nav class="navlinks" id="navlinks">${links}</nav>
      <div class="nav-right">
        <button class="iconbtn" id="notif-btn" aria-label="Notifications">${ICONS.bell}<span class="badge-count hidden" id="notif-count"></span></button>
        <button class="usermenu-btn" id="user-btn">
          <span class="avatar">${esc(initials(u.full_name))}</span>
          <span class="uname">${esc(u.full_name)}</span>
          <span class="role-badge r-${esc(u.role)}">${esc(u.role)}</span>
        </button>
      </div>
      <div class="dropdown hidden" id="notif-dd">
        <div class="dd-head"><strong class="grow">Notifications</strong><button class="btn sm ghost" id="notif-readall">Mark all read</button></div>
        <div class="notif-list" id="notif-list"><div class="empty">Loading…</div></div>
      </div>
      <div class="dropdown hidden" id="user-dd">
        <div class="dd-head">
          <span class="avatar">${esc(initials(u.full_name))}</span>
          <div class="grow"><div><strong>${esc(u.full_name)}</strong></div><div class="dim mono">@${esc(u.username)}</div></div>
          <span class="role-badge r-${esc(u.role)}">${esc(u.role)}</span>
        </div>
        <div class="dd-mode"><span class="dim">Appearance</span>${appearanceSeg()}</div>
        <div class="dd-item dd-static"><span class="dim">Group</span> ${u.group ? `<span class="group-chip">${esc(u.group)}</span>` : '<span class="dim">Not enrolled</span>'}</div>
        <a class="dd-item" href="/profile">Profile &amp; 2FA</a>
        <button class="dd-item" id="logout-btn">Sign out</button>
      </div>`;

    const navlinks = nav.querySelector('#navlinks');
    const nd = nav.querySelector('#notif-dd');
    const ud = nav.querySelector('#user-dd');
    const closeAll = () => { nd.classList.add('hidden'); ud.classList.add('hidden'); navlinks.classList.remove('open'); };
    nav.querySelector('#nav-toggle').addEventListener('click', (e) => { e.stopPropagation(); const o = !navlinks.classList.contains('open'); closeAll(); navlinks.classList.toggle('open', o); });
    nav.querySelector('#user-btn').addEventListener('click', (e) => { e.stopPropagation(); const o = ud.classList.contains('hidden'); closeAll(); ud.classList.toggle('hidden', !o); });
    nav.querySelector('#notif-btn').addEventListener('click', (e) => {
      e.stopPropagation(); const o = nd.classList.contains('hidden'); closeAll(); nd.classList.toggle('hidden', !o);
      if (o) loadNotifications(true);
    });
    [nd, ud].forEach((d) => d.addEventListener('click', (e) => e.stopPropagation()));
    document.addEventListener('click', closeAll);
    bindAppearance(nav.querySelector('#user-dd'));
    nav.querySelector('#logout-btn').addEventListener('click', async () => {
      try { await api('POST', '/api/auth/logout'); } catch (_) { /* ignore */ }
      location.href = '/login';
    });
    nav.querySelector('#notif-readall').addEventListener('click', async () => {
      await api('POST', '/api/notifications/read-all');
      loadNotifications(true);
    });
  }

  async function loadNotifications(renderList) {
    let data;
    try { data = await api('GET', '/api/notifications'); } catch (e) { return; }
    const c = document.getElementById('notif-count');
    if (c) { c.textContent = data.unread > 99 ? '99+' : data.unread; c.classList.toggle('hidden', !data.unread); }
    if (!renderList) return;
    const list = document.getElementById('notif-list');
    if (!list) return;
    if (!data.rows.length) { list.innerHTML = '<div class="empty">You\'re all caught up.</div>'; return; }
    list.innerHTML = data.rows.map((n) => `
      <div class="notif ${n.is_read ? '' : 'unread'}" data-id="${n.id}" data-link="${esc(n.link || '')}">
        <div class="n-title">${esc(n.title)}</div>
        ${n.body ? `<div class="n-body">${esc(n.body)}</div>` : ''}
        <div class="n-time">${esc(ago(n.created_at))}</div>
      </div>`).join('');
    list.querySelectorAll('.notif').forEach((el) => el.addEventListener('click', async () => {
      try { await api('POST', `/api/notifications/${el.dataset.id}/read`); } catch (_) { /* ignore */ }
      const link = el.dataset.link;
      // Only follow same-origin relative links
      if (link && link.startsWith('/') && !link.startsWith('//')) location.href = link;
      else loadNotifications(true);
    }));
  }

  function registerSW() {
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
    }
  }

  async function init(current) {
    registerSW();
    const [me, b] = await Promise.all([api('GET', '/api/auth/me'), loadBranding()]);
    theme.mode = me.user.appearance || 'system';
    applyTheme();
    const ctx = { ...me, branding: b, can: (a) => me.actions.includes(a), canPage: (p) => me.pages.some((x) => x.path === p), hasSection: (k) => me.sections.includes(k) };
    document.title = `${(me.pages.find((p) => p.path === current) || {}).label || 'Home'} · ${b.app_name}`;
    renderNav(ctx, current);
    loadNotifications(false);
    setInterval(() => { if (!document.hidden) loadNotifications(false); }, 30000);
    return ctx;
  }

  function qs(name) { return new URLSearchParams(location.search).get(name); }

  window.App = {
    api, toast, esc, fmtDate, fmtDateTime, ago, today, pill, modal, confirmDialog, formData, options,
    download, init, loadBranding, brandHtml, previewTheme, setAppearance, appearanceSeg, bindAppearance, registerSW, ICONS, qs, initials,
  };
})();
