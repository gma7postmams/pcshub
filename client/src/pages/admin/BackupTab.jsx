import { useCallback, useEffect, useRef, useState } from 'react';
import { get, post, put } from '../../lib/api.js';
import { fmtBytes } from '../../lib/util.js';
import { Empty, Modal, useToast } from '../../components/ui.jsx';

const COUNT_TILES = [
  ['users', 'Users'], ['groups', 'Groups'], ['programs', 'Programs'], ['platforms', 'Platforms'],
  ['knowledge_docs', 'Knowledge Documents'], ['ingest_records', 'Ingest Records'], ['workload_items', 'Workload Records'], ['audit_logs', 'Audit Logs'],
  ['branding_files', 'Branding Files', (c, f) => f.branding.count],
];

function Environment({ env }) {
  const warns = [];
  if (!env.pgDump.ok) warns.push(`pg_dump is unavailable: ${env.pgDump.error}. Backups cannot be created.`);
  if (!env.pgRestore.ok) warns.push('pg_restore is unavailable: backups cannot be fully verified.');
  if (!env.storageWritable) warns.push('The backup directory is not writable.');
  if (!env.signing) warns.push('BACKUP_SIGNING_KEY is not set: new backups are unsigned, so tampering with the manifest cannot be detected.');
  if (!warns.length) return null;
  return <div className="alert warn mb-12">{warns.map((w) => <div key={w}>{w}</div>)}</div>;
}

function PreviewCard({ preview, onCreate, busy }) {
  const { counts, files, environment: env } = preview;
  return (
    <div className="card mb-12">
      <div className="card-head">
        <h2>Backup preview</h2>
        <button type="button" className="btn primary sm" disabled={busy || !env.pgDump.ok || !env.storageWritable} onClick={onCreate}>Create backup</button>
      </div>
      <div className="card-pad">
        <Environment env={env} />
        <div className="stat-grid">
          {COUNT_TILES.map(([k, label, value]) => (
            <div className="stat" key={k}>
              <span className="stat-label">{label}</span>
              <span className="stat-value">{(value ? value(counts, files) : counts[k]).toLocaleString()}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function StorageCard({ preview }) {
  const { files, totals, environment: env } = preview;
  const rows = [
    ['Branding Assets', `${files.branding.count} ${files.branding.count === 1 ? 'file' : 'files'}`, fmtBytes(files.branding.bytes)],
    ['Knowledge Assets', `${files.knowledge.count} ${files.knowledge.count === 1 ? 'file' : 'files'}`, fmtBytes(files.knowledge.bytes)],
    ['Database Size', null, fmtBytes(totals.databaseBytes)],
    ['Estimated Backup Size', null, `~${fmtBytes(totals.estimatedArchiveBytes)}`],
    ['Free Storage Capacity', null, env.freeBytes == null ? 'Unknown' : fmtBytes(env.freeBytes)],
  ];
  return (
    <div className="card mb-12">
      <div className="card-head"><h2>Storage &amp; Capacity</h2></div>
      <div className="card-pad">
        {rows.map(([label, count, size]) => (
          <div className="kv-row" key={label}>
            <span className="kv-label">{label}</span>
            <span className="kv-value">{count ? <span className="dim">{count}</span> : null}<strong>{size}</strong></span>
          </div>
        ))}
        <div className="dim mt-12">Sizes are estimates. The actual archive is measured when the backup finishes.</div>
      </div>
    </div>
  );
}

function CreateDialog({ preview, onClose, onStarted }) {
  const toast = useToast();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const { counts, totals } = preview;
  const start = async () => {
    setBusy(true);
    try { await post('/api/admin/backups', { note }); toast('Backup started'); onStarted(); } catch (e) { toast(e.message, 'err'); setBusy(false); }
  };
  return (
    <Modal
      title="Create backup"
      onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn primary" disabled={busy} onClick={start}>{busy ? 'Starting…' : 'Start backup'}</button></>}
    >
      <p className="muted">Creates a full archive of the database, branding files and knowledge documents ({counts.users} users, {counts.knowledge_docs} documents, {counts.audit_logs.toLocaleString()} audit entries; about {fmtBytes(totals.estimatedArchiveBytes)}). Users can keep working while it runs.</p>
      <div className="alert info mb-12">The archive contains password hashes and 2FA secrets. Store downloaded copies securely.</div>
      <label className="f"><span>Note (optional)</span><input maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Before month-end close" /></label>
    </Modal>
  );
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Automatic backups: when, and how many to keep (the oldest are removed when there are more).
function ScheduleCard({ onSaved }) {
  const toast = useToast();
  const [s, setS] = useState(null);
  const [max, setMax] = useState(30);
  const [busy, setBusy] = useState(false);
  useEffect(() => { get('/api/admin/backups/status').then((st) => { setS(st.schedule); setMax(st.maxBackups); }).catch(() => {}); }, []);
  if (!s) return null;
  const set = (k) => (e) => setS((x) => ({ ...x, [k]: k === 'keep' || k === 'weekday' ? Number(e.target.value) : e.target.value }));
  const save = async () => {
    setBusy(true);
    try { await put('/api/admin/backups/schedule', s); toast('Schedule saved'); onSaved(); } catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  };
  return (
    <div className="card mb-12">
      <div className="card-head"><h2>Automatic backups</h2><button type="button" className="btn primary sm" disabled={busy} onClick={save}>Save schedule</button></div>
      <div className="card-pad">
        <div className="sched-grid">
          <label className="f"><span>How often</span>
            <select value={s.mode} onChange={set('mode')}><option value="off">Off</option><option value="daily">Every day</option><option value="weekly">Once a week</option></select></label>
          {s.mode === 'weekly' ? <label className="f"><span>Day</span><select value={s.weekday} onChange={set('weekday')}>{DAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}</select></label> : null}
          {s.mode !== 'off' ? <label className="f"><span>Time (server)</span><input type="time" value={s.time} onChange={set('time')} /></label> : null}
          <label className="f"><span>Keep the latest</span><input type="number" min={1} max={max} value={s.keep} onChange={set('keep')} /></label>
        </div>
        <div className="dim mt-12">Older backups beyond this number are deleted automatically (at most {max} can be kept). Scheduled backups appear in History marked as <em>Scheduled backup</em>.</div>
      </div>
    </div>
  );
}

export default function BackupTab({ running, refreshKey, onStarted }) {
  const toast = useToast();
  const [preview, setPreview] = useState(null);
  const [creating, setCreating] = useState(false);

  const loadPreview = useCallback(() => get('/api/admin/backups/preview').then(setPreview).catch((e) => toast(e.message, 'err')), [toast]);
  useEffect(() => { loadPreview(); }, [loadPreview, refreshKey]);
  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !running) loadPreview();
    wasRunning.current = running;
  }, [running, loadPreview]);

  if (!preview) return <Empty>Loading…</Empty>;
  return (
    <>
      <PreviewCard preview={preview} busy={running} onCreate={() => setCreating(true)} />
      <ScheduleCard onSaved={loadPreview} />
      <StorageCard preview={preview} />
      {creating ? <CreateDialog preview={preview} onClose={() => setCreating(false)} onStarted={() => { setCreating(false); onStarted(); }} /> : null}
    </>
  );
}
