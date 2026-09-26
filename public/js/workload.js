(async function () {
  'use strict';
  const { api, esc } = App;
  await App.init('/workload');
  const main = document.getElementById('main');

  // Work Load Tracker — fields not defined yet (to be built).
  // When fields exist, /api/workload/meta returns them and this page renders Table + Excel modes.
  const meta = await api('GET', '/api/workload/meta');
  let mode = 'table';

  function render() {
    main.innerHTML = `
      <div class="page-head">
        <div><h1>Work Load Tracker</h1><div class="sub">Fields to be defined.</div></div>
        <div class="actions">
          <div class="segmented" id="mode-seg">
            <button data-m="table" class="${mode === 'table' ? 'on' : ''}">Table</button>
            <button data-m="excel" class="${mode === 'excel' ? 'on' : ''}">Excel</button>
          </div>
        </div>
      </div>
      <div class="card">
        ${meta.ready ? '' : `
        <div class="empty">
          <h2 class="mb-12">Fields not defined yet</h2>
          <div>The Work Load Tracker is being built. Its ${esc(mode === 'excel' ? 'Excel grid' : 'table')} will appear here once the fields are set.</div>
        </div>`}
      </div>`;
    main.querySelectorAll('#mode-seg button').forEach((b) => b.addEventListener('click', () => { mode = b.dataset.m; render(); }));
  }
  render();
})();
