(async function () {
  'use strict';
  const { api, esc, pill, fmtDate, fmtDateTime, toast, modal, confirmDialog, options, qs } = App;
  const ctx = await App.init('/ingest');
  const canWrite = ctx.can('ingest.write');
  const canDelete = ctx.can('ingest.delete');
  const main = document.getElementById('main');
  const STATUSES = ['New', 'Pending Approval', 'Approved', 'Rejected'];
  const EDITABLE = ['New', 'Rejected'];
  const PAGE = 50;

  const [dd, users] = await Promise.all([
    api('GET', '/api/dropdowns?categories=program,platform'),
    api('GET', '/api/users/active'),
  ]);
  const state = { offset: 0, status: qs('status') || '', program: '', platform: '', q: '', from: '', to: '' };

  main.innerHTML = `
    <div class="page-head">
      <div><h1>Ingest Tracker</h1><div class="sub">Log ingest requests and send them for approval.</div></div>
      <div class="actions">${canWrite ? `<button class="btn primary" id="new-btn">${App.ICONS.plus} New Ingest</button>` : ''}</div>
    </div>
    ${!dd.program.length ? `<div class="alert warn mb-12">No PROGRAM options exist yet. ${ctx.canPage('/admin') ? 'Add them in <a href="/admin#dropdowns">Admin → Dropdowns</a>.' : 'Ask an Admin to add them.'}</div>` : ''}
    <div class="card">
      <div class="filters">
        <input type="search" id="f-q" placeholder="Search program, source, folder, remarks…">
        <select id="f-status">${options(STATUSES, state.status, { blank: 'All statuses' })}</select>
        <select id="f-program">${options(dd.program, '', { blank: 'All programs' })}</select>
        <select id="f-platform">${options(dd.platform, '', { blank: 'All platforms' })}</select>
        <input type="date" id="f-from" title="Episode date from">
        <input type="date" id="f-to" title="Episode date to">
      </div>
      <div class="table-wrap" id="tbl"></div>
      <div class="pager"><span id="pg-info"></span><span class="grow"></span>
        <button class="btn sm" id="pg-prev">Previous</button><button class="btn sm" id="pg-next">Next</button></div>
    </div>`;

  let total = 0;
  async function load() {
    const p = new URLSearchParams({ limit: PAGE, offset: state.offset });
    ['status', 'program', 'platform', 'q', 'from', 'to'].forEach((k) => { if (state[k]) p.set(k, state[k]); });
    const tbl = document.getElementById('tbl');
    let data;
    try { data = await api('GET', `/api/ingest?${p}`); } catch (e) { tbl.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
    total = data.total;
    tbl.innerHTML = data.rows.length ? `
      <table class="t"><thead><tr>
        <th>#</th><th>Program</th><th>Platform</th><th>Episode Date</th><th>Source</th><th>Destination Folder</th>
        <th>Requested By</th><th>Requested By (PSD)</th><th>Status</th><th>Updated</th></tr></thead>
      <tbody>${data.rows.map((r) => `
        <tr class="clickable" data-id="${r.id}">
          <td class="dim mono">${r.id}</td>
          <td><strong>${esc(r.program)}</strong></td>
          <td>${esc(r.platform)}</td>
          <td class="nowrap">${esc(fmtDate(r.episode_date))}</td>
          <td class="cell-clip" title="${esc(r.source)}">${esc(r.source)}</td>
          <td class="cell-clip mono" title="${esc(r.destination_folder)}">${esc(r.destination_folder)}</td>
          <td class="nowrap">${esc(r.requested_by_name || '')}</td>
          <td>${esc(r.requested_by_psd || '')}</td>
          <td>${pill(r.status)}</td>
          <td class="dim nowrap">${esc(App.ago(r.updated_at))}</td>
        </tr>`).join('')}</tbody></table>`
      : '<div class="empty">No ingest records match these filters.</div>';
    tbl.querySelectorAll('tr.clickable').forEach((tr) => tr.addEventListener('click', () => openDetail(+tr.dataset.id)));
    document.getElementById('pg-info').textContent = total
      ? `${state.offset + 1}–${Math.min(state.offset + PAGE, total)} of ${total}` : '';
    document.getElementById('pg-prev').disabled = state.offset === 0;
    document.getElementById('pg-next').disabled = state.offset + PAGE >= total;
  }

  let qTimer;
  const bind = (id, key, evt = 'change') => document.getElementById(id).addEventListener(evt, (e) => {
    state[key] = e.target.value; state.offset = 0;
    if (evt === 'input') { clearTimeout(qTimer); qTimer = setTimeout(load, 300); } else load();
  });
  bind('f-q', 'q', 'input'); bind('f-status', 'status'); bind('f-program', 'program'); bind('f-platform', 'platform');
  bind('f-from', 'from'); bind('f-to', 'to');
  document.getElementById('pg-prev').addEventListener('click', () => { state.offset = Math.max(0, state.offset - PAGE); load(); });
  document.getElementById('pg-next').addEventListener('click', () => { state.offset += PAGE; load(); });
  if (canWrite) document.getElementById('new-btn').addEventListener('click', () => openForm(null));

  // ---------- Form ----------
  function withCurrent(list, val) { return val && !list.includes(val) ? [...list, val] : list; }

  function openForm(rec) {
    const r = rec || {};
    const userOpts = users.map((u) => ({ value: u.id, label: u.full_name }));
    const m = modal({
      title: rec ? `Edit Ingest #${rec.id}` : 'New Ingest',
      body: `<form id="ing-form" class="form-grid" novalidate>
        <label class="f"><span>PROGRAM <span class="req">*</span></span>
          <select name="program" required>${options(withCurrent(dd.program, r.program), r.program, { blank: 'Select program…' })}</select></label>
        <label class="f"><span>Platform <span class="req">*</span></span>
          <select name="platform" required>${options(withCurrent(dd.platform, r.platform), r.platform, { blank: 'Select platform…' })}</select></label>
        <label class="f"><span>Episode date</span><input type="date" name="episode_date" value="${esc(r.episode_date || '')}"></label>
        <label class="f"><span>Source</span><input name="source" maxlength="500" value="${esc(r.source || '')}" placeholder="e.g. Tape, drive, server path"></label>
        <label class="f full"><span>Destination Folder</span><input name="destination_folder" maxlength="1000" class="mono" value="${esc(r.destination_folder || '')}" placeholder="\\\\server\\share\\promos\\…"></label>
        <label class="f"><span>Requested by</span>
          <select name="requested_by_user_id">${options(userOpts, r.requested_by_user_id || (rec ? '' : ctx.user.id), { blank: '—' })}</select></label>
        <label class="f"><span>Requested by (PSD)</span><input name="requested_by_psd" maxlength="200" value="${esc(r.requested_by_psd || '')}"></label>
        <label class="f full"><span>Remarks</span><textarea name="remarks" maxlength="4000">${esc(r.remarks || '')}</textarea></label>
        ${!rec ? '<div class="full dim">Status will be set to <strong>New</strong>. Send it for approval when ready.</div>' : ''}
      </form>`,
      foot: `<button class="btn" data-close>Cancel</button>
             ${!rec ? '<button class="btn" id="save-send">Save &amp; Send for Approval</button>' : ''}
             <button class="btn primary" id="save">Save</button>`,
    });
    const form = m.el.querySelector('#ing-form');
    async function submit(send) {
      const body = App.formData(form);
      if (!body.program || !body.platform) { toast('PROGRAM and Platform are required', 'err'); return; }
      m.el.querySelectorAll('.modal-foot .btn').forEach((b) => { b.disabled = true; });
      try {
        let id = rec && rec.id;
        if (rec) await api('PUT', `/api/ingest/${rec.id}`, body);
        else id = (await api('POST', '/api/ingest', body)).id;
        if (send) await api('POST', `/api/ingest/${id}/send`);
        toast(send ? 'Saved and sent for approval' : 'Saved');
        m.close(); load();
      } catch (e) {
        toast(e.message, 'err');
        m.el.querySelectorAll('.modal-foot .btn').forEach((b) => { b.disabled = false; });
      }
    }
    m.el.querySelector('#save').addEventListener('click', () => submit(false));
    const ss = m.el.querySelector('#save-send');
    if (ss) ss.addEventListener('click', () => submit(true));
  }

  // ---------- Detail ----------
  async function openDetail(id) {
    let r;
    try { r = await api('GET', `/api/ingest/${id}`); } catch (e) { toast(e.message, 'err'); return; }
    const editable = canWrite && EDITABLE.includes(r.status);
    const kv = (k, v) => `<dt>${esc(k)}</dt><dd>${v || '<span class="dim">—</span>'}</dd>`;
    const m = modal({
      title: `Ingest #${r.id}`,
      body: `
        <div class="row mb-12">${pill(r.status)}<span class="dim">Created ${esc(fmtDateTime(r.created_at))} by ${esc(r.created_by_name || '—')}</span></div>
        ${r.status === 'Rejected' && r.last_approval && r.last_approval.decision_note
          ? `<div class="alert err mb-12"><strong>Rejected:</strong> ${esc(r.last_approval.decision_note)}</div>` : ''}
        <dl class="kv">
          ${kv('PROGRAM', esc(r.program))}
          ${kv('Platform', esc(r.platform))}
          ${kv('Episode date', esc(fmtDate(r.episode_date)))}
          ${kv('Source', esc(r.source))}
          ${kv('Destination Folder', r.destination_folder ? `<span class="mono">${esc(r.destination_folder)}</span>` : '')}
          ${kv('Requested by', esc(r.requested_by_name))}
          ${kv('Requested by (PSD)', esc(r.requested_by_psd))}
          ${kv('Remarks', esc(r.remarks))}
          ${kv('Last updated', `${esc(fmtDateTime(r.updated_at))}${r.updated_by_name ? ` by ${esc(r.updated_by_name)}` : ''}`)}
        </dl>
        ${r.approvals.length ? `<h3 class="mt-16 mb-12">Approval history</h3><div class="timeline">${r.approvals.map((a) => `
          <div class="ti"><div>${pill(a.status)} <span class="dim">requested ${esc(fmtDateTime(a.requested_at))} by ${esc(a.requested_by_name || '—')}</span></div>
          ${a.decided_at ? `<div class="mt-6">${esc(a.status)} by ${esc(a.decided_by_name || '—')} · ${esc(fmtDateTime(a.decided_at))}</div>` : ''}
          ${a.decision_note ? `<div class="muted mt-6">“${esc(a.decision_note)}”</div>` : ''}</div>`).join('')}</div>` : ''}`,
      foot: `
        ${canDelete ? '<button class="btn danger" id="del">Delete</button>' : ''}
        <span class="grow"></span>
        <button class="btn" data-close>Close</button>
        ${editable ? '<button class="btn" id="edit">Edit</button>' : ''}
        ${editable ? `<button class="btn primary" id="send">${r.status === 'Rejected' ? 'Resubmit for Approval' : 'Send for Approval'}</button>` : ''}`,
    });
    const on = (sel, fn) => { const b = m.el.querySelector(sel); if (b) b.addEventListener('click', fn); };
    on('#edit', () => { m.close(); openForm(r); });
    on('#send', async () => {
      if (!(await confirmDialog('Send for approval', `Send ingest #${r.id} (${r.program}) to Managers for approval? It will be locked from editing while pending.`, { okText: 'Send' }))) return;
      try { await api('POST', `/api/ingest/${r.id}/send`); toast('Sent for approval'); m.close(); load(); } catch (e) { toast(e.message, 'err'); }
    });
    on('#del', async () => {
      if (!(await confirmDialog('Delete ingest record', `Permanently delete ingest #${r.id} and its approval history?`, { okText: 'Delete', danger: true }))) return;
      try { await api('DELETE', `/api/ingest/${r.id}`); toast('Deleted'); m.close(); load(); } catch (e) { toast(e.message, 'err'); }
    });
  }

  await load();
  if (qs('new') && canWrite) openForm(null);
  if (qs('id')) openDetail(+qs('id'));
})();
