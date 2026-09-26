(async function () {
  'use strict';
  const { api, esc, fmtDate, options, toast } = App;
  const ctx = await App.init('/reports');
  const canSummary = ctx.hasSection('reports.ingest');
  const canExport = ctx.hasSection('reports.export');
  const main = document.getElementById('main');
  const dd = await api('GET', '/api/dropdowns?categories=program,platform');

  const firstOfMonth = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`; };
  const f = { from: '', to: '', program: '', platform: '', status: '', basis: 'created' };

  main.innerHTML = `
    <div class="page-head">
      <div><h1>Reports</h1><div class="sub">Ingest and approval summaries.</div></div>
      <div class="actions">
        <button class="btn" id="print">Print</button>
        ${canExport ? `<a class="btn primary" id="csv" href="#">${App.ICONS.download} Export CSV</a>` : ''}
      </div>
    </div>
    <section id="t-ingest">
      <div class="card mb-12">
        <div class="filters">
          <select id="f-basis" title="Date basis"><option value="created">By created date</option><option value="episode">By episode date</option></select>
          <input type="date" id="f-from" title="From"><input type="date" id="f-to" title="To">
          <select id="f-program">${options(dd.program, '', { blank: 'All programs' })}</select>
          <select id="f-platform">${options(dd.platform, '', { blank: 'All platforms' })}</select>
          <select id="f-status">${options(['New', 'Pending Approval', 'Approved', 'Rejected'], '', { blank: 'All statuses' })}</select>
          <div class="segmented" id="presets"><button data-p="month">This month</button><button data-p="30">30 days</button><button data-p="all" class="on">All time</button></div>
        </div>
      </div>
      <div id="ingest-body"></div>
    </section>`;

  function bars(list, { color } = {}) {
    if (!list.length) return '<div class="empty">No data</div>';
    const max = Math.max(...list.map((x) => x.n), 1);
    return `<div class="bars">${list.map((x) => `
      <div class="bar-row"><span class="lbl" title="${esc(x.k)}">${esc(x.k)}</span>
        <div class="bar-track"><div class="bar-fill" data-pct="${(x.n / max) * 100}" ${color ? `data-color="${color}"` : ''}></div></div>
        <span class="val">${x.n}</span></div>`).join('')}</div>`;
  }
  const monthLabel = (k) => { const [y, m] = k.split('-').map(Number); return `${new Date(y, m - 1, 1).toLocaleString(undefined, { month: 'short' })} '${String(y).slice(2)}`; };
  function columns(list) {
    if (!list.length) return '<div class="empty">No data</div>';
    const max = Math.max(...list.map((x) => x.n), 1);
    return `<div class="cols">${list.map((x) => `
      <div class="col"><span class="c-val">${x.n}</span><div class="c-bar" data-hpct="${(x.n / max) * 100}"></div>
      <span class="c-lbl">${esc(monthLabel(x.k))}</span></div>`).join('')}</div>`;
  }
  const STATUS_COLOR = { 'New': '--blue', 'Pending Approval': '--amber', 'Approved': '--green', 'Rejected': '--red',
     };
  function paint(root) {
    // CSP-safe sizing (no inline style attributes)
    requestAnimationFrame(() => {
      root.querySelectorAll('.bar-fill').forEach((el) => {
        el.style.width = `${el.dataset.pct}%`;
        const lbl = el.closest('.bar-row').querySelector('.lbl').textContent;
        if (el.dataset.color === 'status' && STATUS_COLOR[lbl]) el.style.background = `var(${STATUS_COLOR[lbl]})`;
      });
      root.querySelectorAll('.c-bar').forEach((el) => { el.style.height = `${Math.max(el.dataset.hpct, 1.5)}%`; });
    });
  }

  function qsFilters() {
    const p = new URLSearchParams();
    Object.entries(f).forEach(([k, v]) => { if (v) p.set(k, v); });
    return p;
  }

  async function loadIngest() {
    const body = document.getElementById('ingest-body');
    if (canExport) document.getElementById('csv').href = `/api/reports/ingest.csv?${qsFilters()}`;
    if (!canSummary) {
      body.innerHTML = `<div class="card"><div class="empty">${canExport
        ? 'Summary is not enabled for your group. Use the filters above and Export CSV.'
        : 'Your group has no Reports sections enabled.'}</div></div>`;
      return;
    }
    let d;
    try { d = await api('GET', `/api/reports/ingest?${qsFilters()}`); } catch (e) { toast(e.message, 'err'); return; }
    const st = Object.fromEntries(d.byStatus.map((x) => [x.k, x.n]));
    const decided = (st.Approved || 0) + (st.Rejected || 0);
    body.innerHTML = `
      <div class="grid grid-4">
        <div class="card kpi c-blue"><div class="k-label">Ingest Records</div><div class="k-value">${d.total}</div></div>
        <div class="card kpi c-green"><div class="k-label">Approval Rate</div><div class="k-value">${decided ? Math.round(((st.Approved || 0) / decided) * 100) : 0}%</div><div class="k-foot">${st.Approved || 0} approved / ${decided} decided</div></div>
        <div class="card kpi c-amber"><div class="k-label">Pending Approval</div><div class="k-value">${st['Pending Approval'] || 0}</div></div>
        <div class="card kpi c-purple"><div class="k-label">Avg. Decision Time</div><div class="k-value">${d.approval.avg_hours != null ? `${d.approval.avg_hours}h` : '—'}</div><div class="k-foot">${d.approval.decided} decisions</div></div>
      </div>
      <div class="grid grid-2 mt-16">
        <div class="card"><div class="card-head"><h3>By Status</h3></div><div class="card-pad">${bars(d.byStatus, { color: 'status' })}</div></div>
        <div class="card"><div class="card-head"><h3>By Platform</h3></div><div class="card-pad">${bars(d.byPlatform)}</div></div>
        <div class="card"><div class="card-head"><h3>Top Programs</h3></div><div class="card-pad">${bars(d.byProgram)}</div></div>
        <div class="card"><div class="card-head"><h3>Monthly Volume (created)</h3></div><div class="card-pad">${columns(d.byMonth)}</div></div>
      </div>`;
    paint(body);
  }

  const bindF = (id, k) => document.getElementById(id).addEventListener('change', (e) => {
    f[k] = e.target.value;
    if (k === 'from' || k === 'to') document.querySelectorAll('#presets button').forEach((b) => b.classList.remove('on'));
    loadIngest();
  });
  bindF('f-basis', 'basis'); bindF('f-from', 'from'); bindF('f-to', 'to');
  bindF('f-program', 'program'); bindF('f-platform', 'platform'); bindF('f-status', 'status');
  document.querySelectorAll('#presets button').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('#presets button').forEach((x) => x.classList.toggle('on', x === b));
    if (b.dataset.p === 'month') { f.from = firstOfMonth(); f.to = App.today(); }
    else if (b.dataset.p === '30') { const d = new Date(Date.now() - 29 * 86400000); f.from = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; f.to = App.today(); }
    else { f.from = ''; f.to = ''; }
    document.getElementById('f-from').value = f.from; document.getElementById('f-to').value = f.to;
    loadIngest();
  }));
  document.getElementById('print').addEventListener('click', () => window.print());

  loadIngest();
})();
