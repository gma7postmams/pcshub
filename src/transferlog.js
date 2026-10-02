// Import / export logging, shared by the Workload and Plug List routes: every run writes an audit entry (Admin → Audit, search
// "import" or "export") AND one line to the server log (stdout -> `journalctl -u pcshub`). Row contents are never logged.
const { audit } = require('./audit');

const logLine = (event, data) => console.log(`[workload] ${event} ${JSON.stringify(data)}`);
const who = (req) => (req.user ? `${req.user.username || req.user.id}` : 'unknown');
async function logRun(req, action, details) {
  logLine(action, { user: who(req), ip: req.ip, ...details });
  await audit(req, action, 'workload_transfer', null, details);
}

module.exports = { logLine, logRun };
