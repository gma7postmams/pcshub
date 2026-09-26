(async function () {
  'use strict';
  const { api, esc, pill, fmtDate, ago } = App;
  const ctx = await App.init('/dashboard');
  const main = document.getElementById('main');
  const d = await api('GET', '/api/dashboard');
  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';

  const kpi = (label, value, foot, color, href) =>
    `<div class="card kpi ${color} ${href ? 'link' : ''}" ${href ? `data-href="${href}"` : ''}>
       <div class="k-label">${esc(label)}</div><div class="k-value">${value}</div>${foot ? `<div class="k-foot">${esc(foot)}</div>` : ''}
     </div>`;
  const ingestHref = (st) => (d.canOpen.ingest ? `/ingest?status=${encodeURIComponent(st)}` : null);

  let kpiHtml = '';
  if (d.kpis) {
    const s = d.kpis.byStatus;
    kpiHtml = `
    <div class="grid grid-4">
      ${kpi('Total Ingest Records', d.kpis.total, `${d.kpis.thisMonth.created} created this month`, 'c-blue', d.canOpen.ingest ? '/ingest' : null)}
      ${kpi('Pending Approval', s['Pending Approval'] || 0, 'Awaiting a decision', 'c-amber', d.canOpen.approval ? '/approval?status=Pending' : null)}
      ${kpi('Approved', s.Approved || 0, `${d.kpis.thisMonth.approved} this month`, 'c-green', ingestHref('Approved'))}
      ${kpi('Rejected', s.Rejected || 0, 'Needs rework & resubmission', 'c-red', ingestHref('Rejected'))}
    </div>`;
  }

  let recentHtml = '';
  if (d.recent) {
    recentHtml = `
    <div class="card ${d.kpis ? 'mt-16' : ''}">
      <div class="card-head"><h2>Recent Ingest Activity</h2>${d.canOpen.ingest ? '<a class="btn sm" href="/ingest">Open tracker</a>' : ''}</div>
      <div class="table-wrap">
        ${d.recent.length ? `<table class="t"><thead><tr><th>#</th><th>Program</th><th>Platform</th><th>Episode</th><th>Status</th><th>Updated</th></tr></thead>
        <tbody>${d.recent.map((r) => `
          <tr class="${d.canOpen.ingest ? 'clickable' : ''}" data-id="${r.id}">
            <td class="dim mono">${r.id}</td><td>${esc(r.program)}</td><td>${esc(r.platform)}</td>
            <td class="nowrap">${esc(fmtDate(r.episode_date))}</td><td>${pill(r.status)}</td>
            <td class="dim nowrap">${esc(ago(r.updated_at))}</td></tr>`).join('')}</tbody></table>`
          : '<div class="empty">No ingest records yet.</div>'}
      </div>
    </div>`;
  }

  main.innerHTML = `
    <div class="page-head">
      <div><h1>${greet}, ${esc(ctx.user.full_name.split(' ')[0])}</h1>
      <div class="sub">Here's where promotional content stands today.</div></div>
      <div class="actions">
        ${ctx.can('ingest.write') ? '<a class="btn primary" href="/ingest?new=1">+ New Ingest</a>' : ''}
        ${d.canOpen.reports ? '<a class="btn" href="/reports">View Reports</a>' : ''}
      </div>
    </div>
    ${kpiHtml}${recentHtml}
    ${!d.kpis && !d.recent ? '<div class="card"><div class="empty">Your group has no Dashboard sections enabled.</div></div>' : ''}`;

  main.querySelectorAll('[data-href]').forEach((el) => el.addEventListener('click', () => { location.href = el.dataset.href; }));
  if (d.canOpen.ingest) {
    main.querySelectorAll('tr.clickable').forEach((tr) => tr.addEventListener('click', () => { location.href = `/ingest?id=${tr.dataset.id}`; }));
  }
})();
