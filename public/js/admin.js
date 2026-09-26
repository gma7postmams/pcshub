(async function () {
  'use strict';
  const { api, esc, fmtDateTime, toast, modal, confirmDialog, options } = App;
  const ctx = await App.init('/admin');
  const main = document.getElementById('main');
  const model = await api('GET', '/api/admin/access-model');
  const ROLES = model.roles;
  const LABEL = Object.fromEntries(model.catalog.flatMap((p) => [[p.key, p.label], ...p.sections.map((x) => [x.key, x.label])]));
  const TABS = [['users', 'Users'], ['groups', 'Groups'], ['roles', 'Roles'], ['dropdowns', 'Dropdowns'], ['branding', 'Branding'], ['audit', 'Audit Log']];

  main.innerHTML = `
    <div class="page-head"><div><h1>Admin</h1><div class="sub">Users, roles, groups, dropdowns, branding and audit.</div></div></div>
    <div class="tabs" id="tabs">${TABS.map(([k, l]) => `<button data-t="${k}">${l}</button>`).join('')}</div>
    <div id="pane"></div>`;

  const pane = document.getElementById('pane');
  function show(tab) {
    if (!TABS.some(([k]) => k === tab)) tab = 'users';
    document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.t === tab));
    history.replaceState(null, '', `#${tab}`);
    ({ users, groups, roles, dropdowns, branding, audit })[tab]();
  }
  document.querySelectorAll('#tabs button').forEach((b) => b.addEventListener('click', () => show(b.dataset.t)));

  // ---------- Users ----------
  let groupList = [];
  async function users() {
    const [list, gl] = await Promise.all([api('GET', '/api/admin/users'), api('GET', '/api/admin/groups')]);
    groupList = gl;
    pane.innerHTML = `<div class="card">
      <div class="card-head"><h2>Users <span class="dim">${list.length}</span></h2><button class="btn primary sm" id="add">${App.ICONS.plus} Add user</button></div>
      <div class="table-wrap"><table class="t"><thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Group</th><th>Status</th><th>2FA</th><th>Last login</th><th></th></tr></thead>
      <tbody>${list.map((u) => `<tr>
        <td><strong>${esc(u.full_name)}</strong>${u.email ? `<div class="dim">${esc(u.email)}</div>` : ''}</td>
        <td class="mono">${esc(u.username)}</td>
        <td><span class="role-badge r-${esc(u.role)}">${esc(u.role)}</span></td>
        <td>${u.group_name ? `<span class="group-chip">${esc(u.group_name)}</span>` : (u.role === 'Admin' ? '<span class="dim">— (full access)</span>' : '<span class="pill s-pending">Not enrolled</span>')}</td>
        <td>${u.is_active ? '<span class="pill s-approved">Active</span>' : '<span class="pill s-hold">Disabled</span>'}
            ${u.locked_until && new Date(u.locked_until) > new Date() ? ' <span class="pill s-rejected">Locked</span>' : ''}
            ${u.must_change_password ? ' <span class="pill s-pending">Must change pw</span>' : ''}</td>
        <td>${u.totp_enabled ? '<span class="yes">On</span>' : '<span class="no">OFF</span>'}</td>
        <td class="dim nowrap">${u.last_login_at ? esc(fmtDateTime(u.last_login_at)) : 'Never'}</td>
        <td class="right"><button class="btn sm" data-edit="${u.id}">Manage</button></td></tr>`).join('')}</tbody></table></div></div>`;
    pane.querySelector('#add').addEventListener('click', () => userForm(null));
    pane.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => userForm(list.find((u) => u.id === +b.dataset.edit))));
  }

  function userForm(u) {
    const self = u && u.id === ctx.user.id;
    const m = modal({
      title: u ? `Manage ${u.full_name}` : 'Add user',
      body: `<form class="form-grid" id="uf" novalidate>
        <label class="f"><span>Full name <span class="req">*</span></span><input name="full_name" maxlength="120" value="${esc(u ? u.full_name : '')}"></label>
        <label class="f"><span>Email</span><input name="email" type="email" maxlength="200" value="${esc(u ? u.email || '' : '')}"></label>
        ${u ? `<label class="f"><span>Username</span><input value="${esc(u.username)}" disabled></label>`
          : '<label class="f"><span>Username <span class="req">*</span></span><input name="username" maxlength="60" autocomplete="off"></label>'}
        <label class="f"><span>Role <span class="req">*</span> <span class="dim">— what they can do</span></span><select name="role">${options(ROLES, u ? u.role : 'Viewer')}</select></label>
        <label class="f"><span>Group <span class="dim">— which pages they can open</span></span><select name="group_id">${options(groupList.map((g) => ({ value: g.id, label: g.name })), u ? u.group_id : '', { blank: '— Not enrolled —' })}</select></label>
        <div class="full dim" id="grp-hint"></div>
        ${!u ? '<label class="f full"><span>Temporary password <span class="req">*</span></span><input name="password" type="text" autocomplete="new-password" placeholder="8+ chars, letters and numbers"><span class="dim mt-6">User must change it at first sign-in.</span></label>' : ''}
        <label class="check full"><input type="checkbox" name="is_active" ${!u || u.is_active ? 'checked' : ''} ${self ? 'disabled' : ''}> Active</label>
        ${self ? '<div class="full alert info">You cannot deactivate or demote yourself if you are the last Admin.</div>' : ''}
      </form>
      ${u ? `<h3 class="mt-16 mb-12">Security</h3><div class="row">
        <button class="btn sm" id="rpw">Reset password</button>
        <button class="btn sm" id="r2fa" ${u.totp_enabled ? '' : 'disabled'}>Reset 2FA</button>
        <button class="btn sm" id="unlock">Unlock</button></div>` : ''}`,
      foot: '<button class="btn" data-close>Cancel</button><button class="btn primary" id="save">Save</button>',
    });
    const roleSel = m.el.querySelector('select[name=role]');
    const grpSel = m.el.querySelector('select[name=group_id]');
    const hint = m.el.querySelector('#grp-hint');
    const updHint = () => {
      if (roleSel.value === 'Admin') { hint.textContent = 'Admin role opens every page regardless of group.'; return; }
      const g = groupList.find((x) => String(x.id) === grpSel.value);
      hint.textContent = g ? `Opens: ${g.perms.filter((k) => !k.includes('.')).map((k) => LABEL[k] || k).join(', ') || 'no pages'} + Profile`
        : 'Not enrolled: user can only open Profile until assigned to a group.';
    };
    roleSel.addEventListener('change', updHint); grpSel.addEventListener('change', updHint); updHint();
    m.el.querySelector('#save').addEventListener('click', async () => {
      const d = App.formData(m.el.querySelector('#uf'));
      if (self) d.is_active = true;
      try {
        if (u) await api('PUT', `/api/admin/users/${u.id}`, d);
        else await api('POST', '/api/admin/users', d);
        toast('User saved'); m.close(); users();
      } catch (e) { toast(e.message, 'err'); }
    });
    if (!u) return;
    m.el.querySelector('#rpw').addEventListener('click', async () => {
      if (!(await confirmDialog('Reset password', `Generate a temporary password for ${u.full_name}? Their sessions will be signed out.`, { okText: 'Reset' }))) return;
      try {
        const r = await api('POST', `/api/admin/users/${u.id}/reset-password`, {});
        modal({ title: 'Temporary password', size: 'sm',
          body: `<p class="muted m-0">Share this securely. It is shown once.</p><div class="secret mt-12">${esc(r.temporary_password)}</div>`,
          foot: '<button class="btn primary" data-close>Done</button>' });
      } catch (e) { toast(e.message, 'err'); }
    });
    m.el.querySelector('#r2fa').addEventListener('click', async () => {
      if (!(await confirmDialog('Reset 2FA', `Remove 2FA from ${u.full_name}? They can set it up again from Profile.`, { okText: 'Reset 2FA', danger: true }))) return;
      try { await api('POST', `/api/admin/users/${u.id}/reset-2fa`, {}); toast('2FA reset'); m.close(); users(); } catch (e) { toast(e.message, 'err'); }
    });
    m.el.querySelector('#unlock').addEventListener('click', async () => {
      try { await api('POST', `/api/admin/users/${u.id}/unlock`, {}); toast('Account unlocked'); m.close(); users(); } catch (e) { toast(e.message, 'err'); }
    });
  }

  // ---------- Dropdowns ----------
  async function dropdowns() {
    const d = await api('GET', '/api/admin/dropdowns');
    const label = { program: 'PROGRAM', platform: 'Platform' };
    pane.innerHTML = `<div class="grid grid-2">${d.categories.map((cat) => {
      const rows = d.rows.filter((r) => r.category === cat);
      return `<div class="card">
        <div class="card-head"><h2>${label[cat] || esc(cat)} <span class="dim">${rows.length}</span></h2></div>
        <form class="filters" data-add="${cat}"><input name="value" placeholder="Add ${esc(label[cat] || cat)}…" maxlength="200" class="grow"><input name="sort_order" type="number" placeholder="Order" class="w-auto"><button class="btn sm primary">Add</button></form>
        <div class="table-wrap"><table class="t"><thead><tr><th>Value</th><th class="num">Order</th><th class="num">Used</th><th>Active</th><th></th></tr></thead>
        <tbody>${rows.map((r) => `<tr>
          <td>${esc(r.value)}</td><td class="num">${r.sort_order}</td><td class="num">${r.usage}</td>
          <td>${r.is_active ? '<span class="yes">Yes</span>' : '<span class="no">NO</span>'}</td>
          <td class="right nowrap"><button class="btn sm" data-edit="${r.id}">Edit</button>
            <button class="btn sm ghost" data-del="${r.id}" ${r.usage ? 'disabled title="In use — deactivate instead"' : ''}>Delete</button></td></tr>`).join('')
          || '<tr><td colspan="5" class="empty">No options yet</td></tr>'}</tbody></table></div></div>`;
    }).join('')}</div>`;

    pane.querySelectorAll('form[data-add]').forEach((f) => f.addEventListener('submit', async (e) => {
      e.preventDefault();
      try { await api('POST', '/api/admin/dropdowns', { category: f.dataset.add, value: f.value.value, sort_order: f.sort_order.value }); toast('Added'); dropdowns(); } catch (ex) { toast(ex.message, 'err'); }
    }));
    pane.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => {
      const r = d.rows.find((x) => x.id === +b.dataset.edit);
      const m = modal({
        title: `Edit ${label[r.category]} option`, size: 'sm',
        body: `<form id="df" class="stack">
          <label class="f"><span>Value</span><input name="value" maxlength="200" value="${esc(r.value)}"></label>
          <label class="f"><span>Sort order</span><input name="sort_order" type="number" value="${r.sort_order}"></label>
          <label class="check"><input type="checkbox" name="is_active" ${r.is_active ? 'checked' : ''}> Active (shown in forms)</label>
          ${r.usage ? `<div class="alert info">Renaming updates the ${r.usage} existing record(s) that use it.</div>` : ''}
        </form>`,
        foot: '<button class="btn" data-close>Cancel</button><button class="btn primary" id="save">Save</button>',
      });
      m.el.querySelector('#save').addEventListener('click', async () => {
        try { await api('PUT', `/api/admin/dropdowns/${r.id}`, App.formData(m.el.querySelector('#df'))); toast('Saved'); m.close(); dropdowns(); } catch (e) { toast(e.message, 'err'); }
      });
    }));
    pane.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
      const r = d.rows.find((x) => x.id === +b.dataset.del);
      if (!(await confirmDialog('Delete option', `Delete "${r.value}"?`, { okText: 'Delete', danger: true }))) return;
      try { await api('DELETE', `/api/admin/dropdowns/${r.id}`); toast('Deleted'); dropdowns(); } catch (e) { toast(e.message, 'err'); }
    }));
  }

  // ---------- Branding ----------
  // Swatch colours for the picker previews (mirror of public/css/app.css palettes)
  const PREVIEW = {
    midnight: { tint: '#4f8cff', dark: '#4f8cff', light: '#2563eb', a2: '#a78bfa' },
    sunset:   { tint: '#ff7a45', dark: '#ff7a45', light: '#c2410c', a2: '#ff4f8b' },
    purple:   { tint: '#8b5cf6', dark: '#9b6bff', light: '#7c3aed', a2: '#ec4899' },
    ocean:    { tint: '#14b8c4', dark: '#22c3d6', light: '#0e7490', a2: '#3b82f6' },
    forest:   { tint: '#22c55e', dark: '#34c77b', light: '#15803d', a2: '#a3e635' },
    rose:     { tint: '#f43f5e', dark: '#fb6f8f', light: '#e11d48', a2: '#fb923c' },
    graphite: { tint: '#94a3b8', dark: '#cbd5e1', light: '#334155', a2: '#64748b' },
  };
  const mix = (hex, pct, base) => {
    const p = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
    const [a, b] = [p(hex), p(base)];
    return `rgb(${a.map((v, i) => Math.round(v * pct + b[i] * (1 - pct))).join(',')})`;
  };

  async function branding() {
    const b = await api('GET', '/api/branding');
    const state = { theme: b.theme, custom: !!b.accent_color, accent: b.accent_color || '#4f8cff' };
    pane.innerHTML = `<div class="grid grid-2">
      <div class="card"><div class="card-head"><h2>Identity</h2></div><form class="card-pad stack" id="bf">
        <label class="f"><span>App name</span><input name="app_name" maxlength="80" value="${esc(b.app_name)}"></label>
        <label class="f"><span>Tagline (login page)</span><input name="tagline" maxlength="120" value="${esc(b.tagline || '')}"></label>
      </form></div>
      <div class="card"><div class="card-head"><h2>Logo</h2></div><div class="card-pad stack">
        <div>${b.logo_url ? `<img class="logo-preview" src="${esc(b.logo_url)}" alt="Current logo">` : '<div class="dim">No logo uploaded — initials mark is used.</div>'}</div>
        <form id="lf" class="stack"><input type="file" name="logo" accept="image/png,image/jpeg,image/webp">
          <div class="row"><button class="btn primary">Upload</button>${b.logo_url ? '<button type="button" class="btn danger" id="rmlogo">Remove</button>' : ''}</div>
          <div class="dim">PNG, JPEG or WebP · max 2 MB · transparent PNG works best on both light and dark.</div></form>
      </div></div>
    </div>
    <div class="card mt-16"><div class="card-head"><h2>Theme</h2><span class="dim">Applies to everyone. Each user picks Dark / Light / System in their Profile.</span></div>
      <div class="card-pad stack">
        <div class="theme-grid" id="tg">${b.themes.map((t) => `
          <button type="button" class="theme-card ${t.key === state.theme ? 'on' : ''}" data-theme-key="${t.key}">
            <div class="sw"><span data-sw="dark"><i></i><i></i></span><span data-sw="light"><i></i><i></i></span></div>
            <div class="nm">${esc(t.label)}</div></button>`).join('')}
        </div>
        <div class="row gap-16">
          <label class="check"><input type="checkbox" id="cust" ${state.custom ? 'checked' : ''}> Custom accent colour</label>
          <input type="color" id="bc" value="${esc(state.accent)}" ${state.custom ? '' : 'disabled'}>
          <input id="bh" maxlength="7" class="mono w-auto" value="${esc(state.accent)}" ${state.custom ? '' : 'disabled'}>
          <span class="dim">Overrides the theme accent in both modes. Button text colour is picked automatically for contrast.</span>
        </div>
        <div class="row"><button class="btn primary" id="save-theme">Save branding &amp; theme</button><button class="btn ghost" id="reset-prev">Reset preview</button></div>
      </div></div>`;

    // paint swatches (CSSOM — CSP allows it; inline style attributes are blocked)
    pane.querySelectorAll('.theme-card').forEach((card) => {
      const c = PREVIEW[card.dataset.themeKey];
      const dk = card.querySelector('[data-sw=dark]'); const lt = card.querySelector('[data-sw=light]');
      dk.style.background = mix(c.tint, 0.08, '#0b0d11'); lt.style.background = mix(c.tint, 0.05, '#f5f6f8');
      lt.style.border = '1px solid #e1e4ea';
      const [d1, d2] = dk.querySelectorAll('i'); const [l1, l2] = lt.querySelectorAll('i');
      d1.style.background = c.dark; d2.style.background = c.a2; l1.style.background = c.light; l2.style.background = c.a2;
    });

    const cust = pane.querySelector('#cust'); const bc = pane.querySelector('#bc'); const bh = pane.querySelector('#bh');
    const preview = () => App.previewTheme(state.theme, state.custom ? state.accent : '');
    pane.querySelectorAll('.theme-card').forEach((card) => card.addEventListener('click', () => {
      state.theme = card.dataset.themeKey;
      pane.querySelectorAll('.theme-card').forEach((c) => c.classList.toggle('on', c === card));
      preview();
    }));
    cust.addEventListener('change', () => { state.custom = cust.checked; bc.disabled = !cust.checked; bh.disabled = !cust.checked; preview(); });
    bc.addEventListener('input', () => { state.accent = bc.value; bh.value = bc.value; preview(); });
    bh.addEventListener('input', () => { if (/^#[0-9a-f]{6}$/i.test(bh.value)) { state.accent = bh.value; bc.value = bh.value; preview(); } });
    pane.querySelector('#reset-prev').addEventListener('click', () => branding().then(() => App.previewTheme(b.theme, b.accent_color)));
    pane.querySelector('#save-theme').addEventListener('click', async () => {
      const f = pane.querySelector('#bf');
      try {
        await api('PUT', '/api/admin/branding', {
          app_name: f.app_name.value, tagline: f.tagline.value, theme: state.theme, accent_color: state.custom ? state.accent : '',
        });
        toast('Branding & theme saved'); setTimeout(() => location.reload(), 500);
      } catch (ex) { toast(ex.message, 'err'); }
    });
    pane.querySelector('#lf').addEventListener('submit', async (e) => {
      e.preventDefault();
      const file = e.target.logo.files[0];
      if (!file) { toast('Choose a file first', 'err'); return; }
      const fd = new FormData(); fd.append('logo', file);
      try { await api('POST', '/api/admin/branding/logo', fd); toast('Logo uploaded'); setTimeout(() => location.reload(), 500); } catch (ex) { toast(ex.message, 'err'); }
    });
    const rm = pane.querySelector('#rmlogo');
    if (rm) rm.addEventListener('click', async () => {
      try { await api('DELETE', '/api/admin/branding/logo'); toast('Logo removed'); setTimeout(() => location.reload(), 500); } catch (ex) { toast(ex.message, 'err'); }
    });
  }

  // ---------- Audit ----------
  const af = { action: '', user: '', from: '', to: '', offset: 0 };
  async function audit() {
    pane.innerHTML = `<div class="card">
      <div class="filters">
        <input type="search" id="a-action" placeholder="Action (e.g. ingest, approval, auth)" value="${esc(af.action)}">
        <input type="search" id="a-user" placeholder="Username" value="${esc(af.user)}">
        <input type="date" id="a-from" value="${esc(af.from)}"><input type="date" id="a-to" value="${esc(af.to)}">
      </div>
      <div class="table-wrap" id="a-tbl"></div>
      <div class="pager"><span id="a-info"></span><span class="grow"></span><button class="btn sm" id="a-prev">Previous</button><button class="btn sm" id="a-next">Next</button></div></div>`;
    let t;
    const bind = (id, k, ev) => pane.querySelector(id).addEventListener(ev, (e) => { clearTimeout(t); t = setTimeout(() => { af[k] = e.target.value; af.offset = 0; loadAudit(); }, 300); });
    bind('#a-action', 'action', 'input'); bind('#a-user', 'user', 'input'); bind('#a-from', 'from', 'change'); bind('#a-to', 'to', 'change');
    pane.querySelector('#a-prev').addEventListener('click', () => { af.offset = Math.max(0, af.offset - 50); loadAudit(); });
    pane.querySelector('#a-next').addEventListener('click', () => { af.offset += 50; loadAudit(); });
    loadAudit();
  }
  async function loadAudit() {
    const p = new URLSearchParams({ limit: 50, offset: af.offset });
    ['action', 'user', 'from', 'to'].forEach((k) => { if (af[k]) p.set(k, af[k]); });
    const d = await api('GET', `/api/admin/audit?${p}`);
    const tbl = document.getElementById('a-tbl');
    tbl.innerHTML = d.rows.length ? `<table class="t"><thead><tr><th>Time</th><th>User</th><th>Action</th><th>Entity</th><th>Details</th><th>IP</th></tr></thead>
      <tbody>${d.rows.map((r) => `<tr>
        <td class="nowrap dim">${esc(fmtDateTime(r.created_at))}</td><td class="mono">${esc(r.username || '—')}</td>
        <td class="mono">${esc(r.action)}</td><td class="nowrap">${esc(r.entity || '')}${r.entity_id ? ` #${esc(r.entity_id)}` : ''}</td>
        <td class="cell-clip mono" title="${esc(r.details ? JSON.stringify(r.details) : '')}">${esc(r.details ? JSON.stringify(r.details) : '')}</td>
        <td class="mono dim">${esc(r.ip || '')}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">No audit entries.</div>';
    document.getElementById('a-info').textContent = d.total ? `${af.offset + 1}–${Math.min(af.offset + 50, d.total)} of ${d.total}` : '';
    document.getElementById('a-prev').disabled = af.offset === 0;
    document.getElementById('a-next').disabled = af.offset + 50 >= d.total;
  }

  // ---------- Groups ----------
  const permChips = (perms) => {
    const pages = model.catalog.filter((p) => perms.includes(p.key));
    if (!pages.length) return '<span class="dim">No pages</span>';
    return `<div class="chips">${pages.map((p) => `<span class="chip">${esc(p.label)}</span>${p.sections.filter((x) => perms.includes(x.key)).map((x) => `<span class="chip sec">${esc(x.label)}</span>`).join('')}`).join('')}</div>`;
  };

  async function groups() {
    groupList = await api('GET', '/api/admin/groups');
    pane.innerHTML = `
      <div class="alert info mb-12">Users are enrolled in one group. The group decides which pages and sections they can open; their <strong>role</strong> decides what they can do there. Admin role opens everything.</div>
      <div class="card">
        <div class="card-head"><h2>Groups <span class="dim">${groupList.length}</span></h2><button class="btn primary sm" id="add">${App.ICONS.plus} Add group</button></div>
        <div class="table-wrap">${groupList.length ? `<table class="t"><thead><tr><th>Group</th><th>Pages &amp; sections</th><th class="num">Members</th><th></th></tr></thead>
        <tbody>${groupList.map((g) => `<tr>
          <td><strong>${esc(g.name)}</strong>${g.description ? `<div class="dim">${esc(g.description)}</div>` : ''}</td>
          <td>${permChips(g.perms)}</td>
          <td class="num">${g.members}</td>
          <td class="right nowrap"><button class="btn sm" data-edit="${g.id}">Edit</button>
            <button class="btn sm ghost" data-del="${g.id}" ${g.members ? 'disabled title="Has members"' : ''}>Delete</button></td></tr>`).join('')}</tbody></table>`
          : '<div class="empty">No groups yet. Add one, tick the pages it can open, then enroll users in it.</div>'}</div>
      </div>`;
    pane.querySelector('#add').addEventListener('click', () => groupForm(null));
    pane.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => groupForm(groupList.find((g) => g.id === +b.dataset.edit))));
    pane.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
      const g = groupList.find((x) => x.id === +b.dataset.del);
      if (!(await confirmDialog('Delete group', `Delete group "${g.name}"?`, { okText: 'Delete', danger: true }))) return;
      try { await api('DELETE', `/api/admin/groups/${g.id}`); toast('Group deleted'); groups(); } catch (e) { toast(e.message, 'err'); }
    }));
  }

  function groupForm(g) {
    const has = new Set(g ? g.perms : []);
    const m = modal({
      title: g ? `Edit group — ${g.name}` : 'Add group',
      body: `<form id="gf" class="stack" novalidate>
        <div class="form-grid">
          <label class="f"><span>Group name <span class="req">*</span></span><input name="name" maxlength="80" value="${esc(g ? g.name : '')}"></label>
          <label class="f"><span>Description</span><input name="description" maxlength="300" value="${esc(g ? g.description || '' : '')}"></label>
        </div>
        <div><div class="row mb-12"><strong class="grow">Pages &amp; sections this group can open</strong>
          <button type="button" class="btn sm ghost" id="all">Select all</button><button type="button" class="btn sm ghost" id="none">Clear</button></div>
        <div class="perm-tree">${model.catalog.map((p) => `
          <div class="perm-page" data-page="${p.key}">
            <label class="check"><input type="checkbox" value="${p.key}" data-kind="page" ${has.has(p.key) ? 'checked' : ''}> ${esc(p.label)} <span class="dim mono">${esc(p.path)}</span></label>
            ${p.sections.length ? `<div class="perm-sections ${has.has(p.key) ? '' : 'off'}">${p.sections.map((x) => `
              <label class="check"><input type="checkbox" value="${x.key}" data-kind="section" ${has.has(x.key) ? 'checked' : ''}> ${esc(x.label)}</label>`).join('')}</div>` : ''}
          </div>`).join('')}</div>
        <div class="dim mt-12">Profile is always available. The Admin page is limited to the Admin role.</div></div>
      </form>`,
      foot: '<button class="btn" data-close>Cancel</button><button class="btn primary" id="save">Save group</button>',
    });
    const tree = m.el.querySelector('.perm-tree');
    const sync = (pageEl, turnOnSections) => {
      const on = pageEl.querySelector('[data-kind=page]').checked;
      const secs = pageEl.querySelector('.perm-sections');
      if (!secs) return;
      secs.classList.toggle('off', !on);
      if (turnOnSections) secs.querySelectorAll('input').forEach((i) => { i.checked = on; });
    };
    tree.querySelectorAll('[data-kind=page]').forEach((cb) => cb.addEventListener('change', () => sync(cb.closest('.perm-page'), true)));
    const setAll = (v) => { tree.querySelectorAll('input[type=checkbox]').forEach((i) => { i.checked = v; }); tree.querySelectorAll('.perm-page').forEach((p) => sync(p, false)); };
    m.el.querySelector('#all').addEventListener('click', () => setAll(true));
    m.el.querySelector('#none').addEventListener('click', () => setAll(false));
    m.el.querySelector('#save').addEventListener('click', async () => {
      const f = m.el.querySelector('#gf');
      const perms = [...tree.querySelectorAll('input:checked')].map((i) => i.value);
      const body = { name: f.name.value, description: f.description.value, perms };
      try {
        if (g) await api('PUT', `/api/admin/groups/${g.id}`, body); else await api('POST', '/api/admin/groups', body);
        toast('Group saved'); m.close(); groups();
      } catch (e) { toast(e.message, 'err'); }
    });
  }

  // ---------- Roles (reference) ----------
  function roles() {
    const ACT = {
      'ingest.write': 'Create / edit / send ingest', 'ingest.delete': 'Delete ingest records',
      'approval.decide': 'Approve / reject', 'workload.write': 'Edit Work Load', 'admin': 'Users, groups, dropdowns, branding, audit',
    };
    const cell = (ok) => (ok ? '<span class="yes">✓</span>' : '<span class="no">—</span>');
    pane.innerHTML = `
      <div class="alert info mb-12">Roles decide what a user can <strong>do</strong>. An action also needs the user's group to open the page it happens on (e.g. approving needs Manager role <em>and</em> a group with the Approval page). Roles are fixed in <span class="mono">src/permissions.js</span>.</div>
      <div class="card"><div class="table-wrap"><table class="t perm-matrix">
        <thead><tr><th>Action</th><th>Needs page</th>${model.roles.map((r) => `<th><span class="role-badge r-${r}">${r}</span></th>`).join('')}</tr></thead>
        <tbody>${Object.keys(model.actionPage).map((a) => `<tr><td>${esc(ACT[a] || a)} <span class="dim mono">${esc(a)}</span></td>
          <td class="dim">${model.actionPage[a] ? esc(LABEL[model.actionPage[a]]) : 'Admin page'}</td>
          ${model.roles.map((r) => `<td>${cell(model.roleActions[r].includes(a))}</td>`).join('')}</tr>`).join('')}
          <tr><td>Open pages / sections</td><td class="dim">—</td>${model.roles.map((r) => `<td class="dim">${r === 'Admin' ? 'All' : 'Per group'}</td>`).join('')}</tr>
        </tbody></table></div></div>`;
  }

  window.addEventListener('hashchange', () => show(location.hash.slice(1)));
  show(location.hash.slice(1));
})();
