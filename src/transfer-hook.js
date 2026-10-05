// Import / export hook — the integration point for the audit log.
//
// The Import and Export buttons (Workload Tracker import / export, PSD Daily Plug List import) do NOT write to the audit log themselves.
// Each time one runs — or fails — it announces it here, and whoever owns the audit log subscribes once:
//
//   const { onTransfer } = require('./src/transfer-hook');
//   onTransfer((e) => audit(e.req, e.action, e.entity, e.entityId, e.details));   // e.g. in server.js, after the audit module is loaded
//
// The event (`e`):
//   action    'workload.export' | 'workload.export_failed' | 'workload.import' | 'workload.import_failed'
//             | 'workload.plugs_import' | 'workload.plugs_import_failed'            (see TRANSFER_ACTIONS)
//   entity    'workload_transfer'   — a suggested value for audit()'s entity argument
//   entityId  null
//   user      { id, username, role } of whoever clicked, or null
//   ip        the client's IP
//   at        ISO timestamp
//   details   plain JSON: file name / size, filters, row counts, rows created / skipped (first 20 skip reasons), duration (ms), and the
//             error message for a *_failed action. Never row contents.
//   req       the Express request, so audit(req, …) can be called exactly as elsewhere in the app
//
// Listeners may be async. A listener that throws (or rejects) is logged and ignored — it can never break an import or export.
// One line per event is also written to the server log (stdout), whether or not anything is subscribed.
const { logLine } = require('./transferlog');

const TRANSFER_ACTIONS = [
  'workload.export', 'workload.export_failed',
  'workload.import', 'workload.import_failed',
  'workload.plugs_import', 'workload.plugs_import_failed',
];

const listeners = [];

/** Subscribe to every import / export event. Returns a function that unsubscribes. */
function onTransfer(fn) {
  if (typeof fn !== 'function') throw new TypeError('onTransfer needs a function');
  listeners.push(fn);
  return () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); };
}

/** Called by the import / export routes. Resolves once every listener has finished; never throws. */
async function emitTransfer(req, action, details) {
  const user = req && req.user ? { id: req.user.id, username: req.user.username, role: req.user.role } : null;
  const event = { action, entity: 'workload_transfer', entityId: null, user, ip: req ? req.ip : undefined, at: new Date().toISOString(), details, req };
  logLine(action, { user: user ? user.username || user.id : 'unknown', ip: event.ip, ...details });
  for (const fn of [...listeners]) {
    try { await fn(event); } catch (e) { console.error(`[transfer-hook] a listener failed on ${action}:`, e && e.message ? e.message : e); }
  }
}

module.exports = { onTransfer, emitTransfer, TRANSFER_ACTIONS };
