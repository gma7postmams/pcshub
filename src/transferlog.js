// Action logging for the Workload / Plug List routes that are NOT import / export (bulk delete, copy to Workload, fill, delete all): an audit
// entry through the app's audit() helper plus one line to the server log (stdout -> `journalctl -u pcshub`). Import / export events go through
// src/transfer-hook.js instead, which leaves the audit log to whoever owns it. Row contents are never logged.
const { audit } = require('./audit');

const logLine = (event, data) => console.log(`[workload] ${event} ${JSON.stringify(data)}`);
const who = (req) => (req.user ? `${req.user.username || req.user.id}` : 'unknown');
async function logRun(req, action, details) {
  logLine(action, { user: who(req), ip: req.ip, ...details });
  await audit(req, action, 'workload_transfer', null, details);
}

module.exports = { logLine, logRun };
