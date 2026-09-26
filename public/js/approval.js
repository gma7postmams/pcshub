(async function () {
  'use strict';
  const { api, esc, pill, fmtDate, fmtDateTime, toast, modal, confirmDialog, qs } = App;
  const ctx = await App.init('/approval');
  const canDecide = ctx.can('approval.decide');
  const main = document.getElementById('main');
  let status = qs('status') || (canDecide ? 'Pending' : '');
  const focusId = qs('id');

  main.innerHTML = `
    <div class="page-head">
      <div><h1>Approval</h1><div class="sub">${canDecide
        ? 'Review ingest requests and approve or reject them.'
        : 'View-only: approval decisions are made by Managers and Admins.'}</div></div>
    </div>
    <div class="card">
      <div class="filters"><div class="segmented" id="seg"></div></div>
      <div class="table-wrap" id="tbl"></div>
    </div>`;

  function renderSeg(counts) {
    const opts = [['Pending', 'Pending'], ['Approved', 'Approved'], ['Rejected', 'Rejected'], ['', 'All']];
    const seg = document.getElementById('seg');
    seg.innerHTML = opts.map(([v, l]) => {
      const n = v ? (counts[v] || 0) : Object.values(counts).reduce((a, b) => a + b, 0);
      return `<button data-v="${v}" class="${status === v ? 'on' : ''}">${l} <span class="dim">${n}</span></button>`;
    }).join('');
    seg.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { status = b.dataset.v; load(); }));
  }

  let rows = [];
  async function load() {
    const p = new URLSearchParams();
    if (status) p.set('status', status);
    const data = await api('GET', `/api/approvals?${p}`);
    rows = data.rows;
    renderSeg(data.counts);
    const tbl = document.getElementById('tbl');
    tbl.innerHTML = rows.length ? `
      <table class="t"><thead><tr><th>Req #</th><th>Ingest #</th><th>Program</th><th>Platform</th><th>Episode</th>
        <th>Sent by</th><th>Sent</th><th>Status</th><th>Decided by</th>${canDecide ? '<th></th>' : ''}</tr></thead>
      <tbody>${rows.map((r) => `
        <tr class="clickable" data-id="${r.id}">
          <td class="dim mono">${r.id}</td><td class="mono">${r.ingest_record_id}</td>
          <td><strong>${esc(r.program)}</strong></td><td>${esc(r.platform)}</td>
          <td class="nowrap">${esc(fmtDate(r.episode_date))}</td>
          <td class="nowrap">${esc(r.requested_by_name || '—')}</td>
          <td class="dim nowrap">${esc(App.ago(r.requested_at))}</td>
          <td>${pill(r.status)}</td>
          <td class="nowrap">${esc(r.decided_by_name || '')}</td>
          ${canDecide ? `<td class="nowrap right">${r.status === 'Pending' ? `
            <button class="btn sm success" data-act="Approved" data-id="${r.id}">Approve</button>
            <button class="btn sm danger" data-act="Rejected" data-id="${r.id}">Reject</button>` : ''}</td>` : ''}
        </tr>`).join('')}</tbody></table>`
      : `<div class="empty">No ${status ? status.toLowerCase() : ''} approval requests.</div>`;
    tbl.querySelectorAll('tr.clickable').forEach((tr) => tr.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      openDetail(rows.find((x) => x.id === +tr.dataset.id));
    }));
    tbl.querySelectorAll('button[data-act]').forEach((b) => b.addEventListener('click', () => decide(+b.dataset.id, b.dataset.act)));
  }

  async function decide(id, decision, parentModal) {
    const r = rows.find((x) => x.id === id) || { program: '', ingest_record_id: '' };
    const res = await confirmDialog(
      decision === 'Approved' ? 'Approve request' : 'Reject request',
      `${decision === 'Approved' ? 'Approve' : 'Reject'} ingest #${r.ingest_record_id} — ${r.program}?`,
      {
        okText: decision === 'Approved' ? 'Approve' : 'Reject',
        danger: decision === 'Rejected',
        input: { label: decision === 'Rejected' ? 'Reason for rejection' : 'Note (optional)', required: decision === 'Rejected' },
      }
    );
    if (!res) return;
    try {
      await api('POST', `/api/approvals/${id}/decide`, { decision, note: res.value });
      toast(`Request ${decision.toLowerCase()}`);
      if (parentModal) parentModal.close();
      load();
    } catch (e) { toast(e.message, 'err'); }
  }

  function openDetail(r) {
    if (!r) return;
    const kv = (k, v) => `<dt>${esc(k)}</dt><dd>${v || '<span class="dim">—</span>'}</dd>`;
    const m = modal({
      title: `Approval Request #${r.id}`,
      body: `
        <div class="row mb-12">${pill(r.status)}<span class="dim">Sent ${esc(fmtDateTime(r.requested_at))} by ${esc(r.requested_by_name || '—')}</span></div>
        <dl class="kv">
          ${kv('Ingest record', `#${r.ingest_record_id} ${ctx.canPage('/ingest') ? `· <a href="/ingest?id=${r.ingest_record_id}">open</a>` : ''}`)}
          ${kv('PROGRAM', esc(r.program))}
          ${kv('Platform', esc(r.platform))}
          ${kv('Episode date', esc(fmtDate(r.episode_date)))}
          ${kv('Source', esc(r.source))}
          ${kv('Destination Folder', r.destination_folder ? `<span class="mono">${esc(r.destination_folder)}</span>` : '')}
          ${kv('Requested by', esc(r.ingest_requested_by_name))}
          ${kv('Requested by (PSD)', esc(r.requested_by_psd))}
          ${kv('Remarks', esc(r.remarks))}
          ${r.decided_at ? kv('Decision', `${esc(r.status)} by ${esc(r.decided_by_name || '—')} · ${esc(fmtDateTime(r.decided_at))}`) : ''}
          ${r.decision_note ? kv('Note', esc(r.decision_note)) : ''}
        </dl>`,
      foot: `<button class="btn" data-close>Close</button>
        ${canDecide && r.status === 'Pending' ? `<button class="btn danger" id="rej">Reject</button><button class="btn success" id="apr">Approve</button>` : ''}`,
    });
    const a = m.el.querySelector('#apr'); const j = m.el.querySelector('#rej');
    if (a) a.addEventListener('click', () => decide(r.id, 'Approved', m));
    if (j) j.addEventListener('click', () => decide(r.id, 'Rejected', m));
  }

  await load();
  if (focusId) {
    let r = rows.find((x) => x.id === +focusId);
    if (!r) { try { r = (await api('GET', `/api/approvals?id=${+focusId}`)).rows[0]; } catch (_) { /* ignore */ } }
    if (r) { if (!rows.includes(r)) rows.push(r); openDetail(r); }
  }
})();
