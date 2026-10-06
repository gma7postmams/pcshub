const path = require('path');
const { canonical } = require('./manifest');
const { walk, sha256File } = require('./archive');
const cfg = require('./config');

const SAMPLE_CAP = 25;
const VOLATILE = "- 'updated_at' - 'id'";

// key = identity across both databases; label = what the Admin recognises; f = comparable fields.
const ENTITIES = [
  { id: 'users', label: 'Users', sql: `SELECT lower(u.username) AS k, u.username AS label,
      jsonb_build_object('full_name', u.full_name, 'email', u.email, 'role', u.role, 'group', g.name,
                         'active', u.is_active, 'two_factor', u.totp_enabled, 'password', md5(u.password_hash)) AS f
      FROM users u LEFT JOIN groups g ON g.id = u.group_id` },
  { id: 'groups', label: 'Groups', sql: `SELECT lower(g.name) AS k, g.name AS label,
      jsonb_build_object('description', g.description,
        'pages', (SELECT string_agg(p.perm_key, ', ' ORDER BY p.perm_key) FROM group_permissions p WHERE p.group_id = g.id)) AS f
      FROM groups g` },
  { id: 'programs', label: 'Programs', sql: `SELECT value AS k, value AS label, jsonb_build_object('active', is_active, 'sort_order', sort_order) AS f
      FROM dropdown_options WHERE category = 'program'` },
  { id: 'platforms', label: 'Platforms', sql: `SELECT value AS k, value AS label, jsonb_build_object('active', is_active, 'sort_order', sort_order) AS f
      FROM dropdown_options WHERE category = 'platform'` },
  { id: 'knowledge_docs', label: 'Knowledge Documents', sql: `SELECT stored_name AS k, title AS label,
      jsonb_build_object('title', title, 'filename', filename, 'sha256', sha256, 'size_bytes', size_bytes) AS f FROM knowledge_docs` },
  { id: 'ingest_records', label: 'Ingest Records', sql: `SELECT id::text AS k, concat_ws(' · ', '#' || id, program, platform) AS label,
      to_jsonb(r) ${VOLATILE} AS f FROM ingest_records r` },
  { id: 'workload_items', label: 'Workload Records', sql: `SELECT id::text AS k, concat_ws(' · ', '#' || id, prog_name, plug_id) AS label,
      to_jsonb(r) ${VOLATILE} AS f FROM workload_items r` },
  // Immutable history: only added/removed make sense, so no fields are compared.
  { id: 'audit_logs', label: 'Audit Logs', sql: `SELECT id::text AS k, action AS label, NULL::jsonb AS f FROM audit_logs` },
];

const show = (v) => {
  if (v === null || v === undefined) return '(empty)';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return s.length > 80 ? `${s.slice(0, 77)}...` : s;
};

function diffRows(curRows, bakRows) {
  const cur = new Map(curRows.map((r) => [r.k, r]));
  const bak = new Map(bakRows.map((r) => [r.k, r]));
  const added = []; const removed = []; const modified = [];
  for (const [k, b] of bak) {
    const c = cur.get(k);
    if (!c) { added.push({ key: k, label: b.label }); continue; }
    if (!b.f || !c.f) continue;
    const changes = Object.keys(b.f).filter((f) => f in c.f && canonical(b.f[f]) !== canonical(c.f[f])).map((f) => (
      f === 'password' ? { field: 'password', from: 'current', to: 'backup' } : { field: f, from: show(c.f[f]), to: show(b.f[f]) }
    ));
    if (changes.length) modified.push({ key: k, label: b.label, changes: changes.slice(0, 8) });
  }
  for (const [k, c] of cur) if (!bak.has(k)) removed.push({ key: k, label: c.label });
  return { current: cur.size, backup: bak.size, added, removed, modified };
}

const sample = (list) => list.slice(0, SAMPLE_CAP);

/** Row-level comparison of live DB (curDb) against the restored scratch DB (bakDb). Entities that cannot be compared are flagged. */
async function compareTables(curDb, bakDb) {
  const out = [];
  for (const e of ENTITIES) {
    try {
      const [c, b] = await Promise.all([curDb.query(e.sql), bakDb.query(e.sql)]);
      const d = diffRows(c.rows, b.rows);
      out.push({
        id: e.id, label: e.label, detail: true, current: d.current, backup: d.backup,
        added: d.added.length, removed: d.removed.length, modified: d.modified.length,
        samples: { added: sample(d.added), removed: sample(d.removed), modified: sample(d.modified) },
      });
    } catch (err) {
      out.push({ id: e.id, label: e.label, detail: false, error: String(err.message).slice(0, 200) });
    }
  }
  return out;
}

/** Fallback when no scratch database is available: only record counts from the backup's summary.json. */
function compareCounts(currentCounts, summaryTables) {
  return ENTITIES.map((e) => ({
    id: e.id, label: e.label, detail: false,
    current: currentCounts[e.id], backup: summaryTables && summaryTables[e.id] != null ? summaryTables[e.id] : null,
  }));
}

/** Uploaded-file comparison using the signed manifest for the backup side and the disk for the current side. */
async function compareFiles(manifestFiles) {
  const out = {};
  for (const comp of cfg.UPLOAD_COMPONENTS) {
    const prefix = `uploads/${comp}/`;
    const bak = new Map((manifestFiles || []).filter((f) => f.path.startsWith(prefix)).map((f) => [f.path.slice(prefix.length), f]));
    const cur = new Map((await walk(path.join(cfg.UPLOADS_ROOT, comp))).map((f) => [f.rel, f]));
    const added = []; const removed = []; const modified = [];
    for (const [rel, b] of bak) {
      const c = cur.get(rel);
      if (!c) added.push({ key: rel, label: rel });
      else if (c.size !== b.size || await sha256File(c.abs) !== b.sha256) modified.push({ key: rel, label: rel, changes: [{ field: 'content', from: 'current', to: 'backup' }] });
    }
    for (const rel of cur.keys()) if (!bak.has(rel)) removed.push({ key: rel, label: rel });
    out[comp] = {
      id: `files_${comp}`, label: comp === 'branding' ? 'Branding Files' : 'Knowledge Files', detail: true, current: cur.size, backup: bak.size,
      added: added.length, removed: removed.length, modified: modified.length,
      samples: { added: sample(added), removed: sample(removed), modified: sample(modified) },
    };
  }
  return out;
}

module.exports = { compareTables, compareCounts, compareFiles };
