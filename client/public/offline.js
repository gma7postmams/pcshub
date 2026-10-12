/* Offline page: show the app name from Administration > Branding (the app keeps the last one in localStorage). */
(function () {
  var n = '';
  try { n = localStorage.getItem('phub-app-name') || ''; } catch (e) { n = ''; }
  if (!n) return;
  document.title = 'Offline \u00b7 ' + n;
  var el = document.getElementById('app-name');
  if (el) el.textContent = n;
})();
