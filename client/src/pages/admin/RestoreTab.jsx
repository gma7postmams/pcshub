import { Fragment, useEffect, useRef, useState } from 'react';
import { api, get, post } from '../../lib/api.js';
import { fmtBytes, fmtDateTime } from '../../lib/util.js';
import { useToast } from '../../components/ui.jsx';
import ReauthDialog from './ReauthDialog.jsx';

const RISK_PILL = { LOW: 's-done', MEDIUM: 's-pending', HIGH: 's-rejected' };
const CHECK_PILL = { pass: 's-done', warn: 's-pending', fail: 's-rejected' };
const READY = {
  ready: ['s-done', 'Ready', 'All checks passed.'],
  caution: ['s-pending', 'Proceed with caution', 'Restore is possible, but review the risk factors and warnings first.'],
  blocked: ['s-rejected', 'Blocked', 'Restore cannot proceed until the failed checks are resolved.'],
};

function uploadZip(file, onProgress) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('POST', '/api/admin/backups/analyze');
    x.setRequestHeader('X-Requested-With', 'PromoHub');
    x.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    x.onload = () => {
      let d = null;
      try { d = JSON.parse(x.responseText); } catch (_) { /* non-JSON error page */ }
      if (x.status === 401) { window.location.href = '/login'; return; }
      if (x.status >= 200 && x.status < 300) resolve(d); else reject(new Error((d && d.error) || `Upload failed (${x.status})`));
    };
    x.onerror = () => reject(new Error('Network error during upload'));
    const fd = new FormData();
    fd.append('file', file);
    x.send(fd);
  });
}

function UploadCard({ busy, uploadPct, onAnalyze }) {
  const [file, setFile] = useState(null);
  const [over, setOver] = useState(false);
  const input = useRef(null);
  const pick = (f) => { if (f) setFile(f); };
  return (
    <div className="card mb-12">
      <div className="card-head"><h2>Upload backup</h2></div>
      <div className="card-pad">
        <div
          className={`dropzone ${over ? 'over' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setOver(true); }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => { e.preventDefault(); setOver(false); pick(e.dataTransfer.files[0]); }}
          onClick={() => !busy && input.current.click()}
        >
          <input ref={input} type="file" accept=".zip,application/zip" hidden onChange={(e) => { pick(e.target.files[0]); e.target.value = ''; }} />
          {file ? <><strong>{file.name}</strong><span className="dim">{fmtBytes(file.size)}</span></> : <span className="dim">Drop a backup .zip here, or click to browse</span>}
        </div>
        {busy && uploadPct != null && uploadPct < 1 ? <progress className="mt-12" max="1" value={uploadPct} style={{ width: '100%' }} /> : null}
        <div className="row mt-12">
          <button type="button" className="btn primary" disabled={!file || busy} onClick={() => onAnalyze(file)}>{busy ? 'Analyzing…' : 'Analyze backup'}</button>
          <span className="dim">Analysis is read-only. Nothing is restored, and the uploaded file is discarded after 30 minutes.</span>
        </div>
      </div>
    </div>
  );
}

function Checks({ checks }) {
  return (
    <table className="t wl">
      <tbody>
        {checks.map((c) => (
          <tr key={c.check}>
            <td className="nowrap" style={{ width: 80 }}><span className={`pill ${CHECK_PILL[c.status]}`}>{c.status}</span></td>
            <td><strong>{c.check}</strong><div className="dim">{c.detail}</div></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Kv({ rows }) {
  return rows.map(([k, a, b]) => (
    <div className="kv-row" key={k}>
      <span className="kv-label">{k}</span>
      <span className="kv-value">{a}{b !== undefined ? <span className="dim">→ {b}</span> : null}</span>
    </div>
  ));
}

function DiffList({ title, items, total, cls }) {
  if (!total) return null;
  return (
    <div className="diff-col">
      <div className={`diff-title ${cls}`}>{title} <span className="dim">({total})</span></div>
      <ul>
        {items.map((i) => (
          <li key={i.key}>
            <span>{i.label || i.key}</span>
            {i.changes ? <div className="dim">{i.changes.map((c) => `${c.field}: ${c.from} → ${c.to}`).join(' · ')}</div> : null}
          </li>
        ))}
      </ul>
      {total > items.length ? <div className="dim">+{total - items.length} more not listed</div> : null}
    </div>
  );
}

const num = (n, cls) => (n ? <strong className={cls}>{n.toLocaleString()}</strong> : <span className="dim">0</span>);

function ImpactTable({ rows }) {
  const [open, setOpen] = useState(null);
  return (
    <div className="table-wrap">
      <table className="t wl">
        <thead>
          <tr><th>Item</th><th className="num">Current</th><th className="num">Backup</th><th className="num">Added</th><th className="num">Removed</th><th className="num">Modified</th><th /></tr>
        </thead>
        <tbody>
          {rows.map((t) => {
            const changed = t.detail && (t.added || t.removed || t.modified);
            return (
              <Fragment key={t.id}>
                <tr>
                  <td><strong>{t.label}</strong></td>
                  <td className="num">{t.current == null ? '—' : t.current.toLocaleString()}</td>
                  <td className="num">{t.backup == null ? '—' : t.backup.toLocaleString()}</td>
                  {t.detail ? (
                    <>
                      <td className="num">{num(t.added, 'c-add')}</td>
                      <td className="num">{num(t.removed, 'c-rem')}</td>
                      <td className="num">{num(t.modified, 'c-mod')}</td>
                    </>
                  ) : (
                    <td className="num dim" colSpan={3} title={t.error}>
                      {t.error
                        ? 'Comparison unavailable'
                        : t.backup == null || t.current == null
                          ? 'Count only'
                          : `Net change ${t.backup - t.current >= 0 ? '+' : ''}${t.backup - t.current} (count only)`}
                    </td>
                  )}
                  <td className="right">
                    {(changed || t.preserved) ? (
                      <button
                        type="button"
                        className="btn sm ghost"
                        onClick={() => setOpen(open === t.id ? null : t.id)}
                      >
                        {open === t.id ? 'Hide' : 'Details'}
                      </button>
                    ) : null}
                  </td>

                </tr>
                {open === t.id ? (
                  <tr className="diff-row">
                    <td colSpan={7}>

                      {t.preserved ? (
                        <div className="alert info mb-12">
                          Audit logs are preserved during restore and are not replaced by the copy contained in the backup.
                        </div>
                      ) : null}

                      <div className="diff-grid">
                        <DiffList title="Added (in backup, not current)" items={t.samples.added} total={t.added} cls="c-add" />
                        <DiffList title="Removed (current, not in backup)" items={t.samples.removed} total={t.removed} cls="c-rem" />
                        <DiffList title="Modified" items={t.samples.modified} total={t.modified} cls="c-mod" />
                      </div>
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Report({ a, onDiscard, onRestore }) {
  const r = a.report;
  const [cls, readyLabel, readyText] = READY[r.readiness.state];
  const b = r.backup;
  return (
    <>
      <div className="card mb-12">
        <div className="card-head">
          <h2>Restore readiness report</h2>
          <button type="button" className="btn sm" onClick={onDiscard}>Discard analysis</button>
          <button type="button" className="btn danger sm" disabled={r.readiness.state === 'blocked'} title={r.readiness.state === 'blocked' ? 'Resolve the failed checks first' : undefined} onClick={onRestore}>Restore</button>
        </div>
        <div className="card-pad">
          <div className="readiness">
            <div><span className="stat-label">Risk level</span><div><span className={`pill risk ${RISK_PILL[r.risk.level]}`}>{r.risk.level}</span></div></div>
            <div><span className="stat-label">Readiness</span><div><span className={`pill ${cls}`}>{readyLabel}</span></div></div>
            <div className="grow dim">{readyText}</div>
          </div>
          {r.risk.blockers.length ? <div className="alert err mt-12">{r.risk.blockers.map((x) => <div key={x}>{x}</div>)}</div> : null}
          <div className="grid grid-3 mt-12">
            <div className="stat"><span className="stat-label">Added</span><span className="stat-value c-add">{r.totals.added.toLocaleString()}</span></div>
            <div className="stat"><span className="stat-label">Removed</span><span className="stat-value c-rem">{r.totals.removed.toLocaleString()}</span></div>
            <div className="stat"><span className="stat-label">Modified</span><span className="stat-value c-mod">{r.totals.modified.toLocaleString()}</span></div>
          </div>
          <div className="dim mt-12">Added = in the backup but not in the live system. Removed = in the live system but not in the backup (a restore would delete it). Audit logs are never deleted by a restore.</div>
        </div>
      </div>

      <div className="card mb-12">
        <div className="card-head"><h2>Structure verification</h2></div>
        <Checks checks={r.structure} />
      </div>

      <div className="grid grid-2 mb-12">
        <div className="card">
          <div className="card-head"><h2>Backup vs current system</h2></div>
          <div className="card-pad">
            {b ? <Kv rows={[
              ['Created', fmtDateTime(b.createdAt), b.ageDays != null ? `${b.ageDays} day(s) old` : undefined],
              ['Created by', b.createdBy || '—'],
              ['Application version', b.appVersion || '—', r.current.appVersion],
              ['Schema version', `v${b.schemaVersion}`, `v${r.current.schemaVersion}`],
              ['PostgreSQL', b.pgServerVersion || '—', r.current.pgServerVersion],
              ['Host', b.hostname || '—', r.current.hostname],
              ['Database', b.databaseName || '—', r.current.databaseName],
              ['Signature', b.signature],
              ['File', r.source.filename, fmtBytes(r.source.sizeBytes)],
            ]} /> : <div className="dim">The manifest could not be read.</div>}
          </div>
        </div>
        <div className="card">
          <div className="card-head"><h2>Risk factors</h2></div>
          <div className="card-pad">
            {r.risk.reasons.length ? (
              <ul className="reasons">
                {r.risk.reasons.map((x) => <li key={x.message}><span className={`pill ${RISK_PILL[x.level]}`}>{x.level}</span> {x.message}</li>)}
              </ul>
            ) : <div className="dim">No significant impact detected.</div>}
          </div>
        </div>
      </div>

      <div className="card mb-12">
        <div className="card-head"><h2>Readiness checks</h2></div>
        <Checks checks={r.readiness.checks} />
      </div>

      <div className="card mb-12">
        <div className="card-head">
          <h2>Current vs backup</h2>
          <span className="dim">{r.mode === 'full' ? 'Row-level comparison' : 'Counts only'}</span>
        </div>
        {r.mode !== 'full' && r.modeReason ? <div className="alert warn" style={{ margin: '12px 18px' }}>{r.modeReason}</div> : null}
        <ImpactTable rows={[...r.tables, ...r.files]} />
      </div>
    </>
  );
}

function RestoreDialog({ a, onClose, onStarted }) {
  const r = a.report;
  const [ack, setAck] = useState(false);
  const submit = async ({ password, code, confirm }) => {
    const { job } = await post('/api/admin/backups/restore', { analysisId: a.id, confirm, acknowledgeRisk: ack, password, code });
    onStarted(job.id);
  };
  return (
    <ReauthDialog
      title="Restore backup"
      okText="Restore now"
      danger
      typed="RESTORE"
      onClose={onClose}
      onSubmit={submit}
      extraReady={r.risk.level !== 'HIGH' || ack}
      intro={`This replaces the live system with ${r.source.filename}.`}
    >
      <div className="alert warn">
        <strong>Important:</strong>
        <div>
          Restoring a backup replaces the current database with the selected backup.
        </div>
        <div>
          Users, roles, groups, ingest records, workload data, settings, and other
          records created after the backup date will be lost.
        </div>
        <div>
          Audit history and backup history are preserved.
        </div>
      </div>

      <div className="readiness">
        <div><span className="stat-label">Risk level</span><div><span className={`pill risk ${RISK_PILL[r.risk.level]}`}>{r.risk.level}</span></div></div>
        <div><span className="stat-label">Added</span><div><strong className="c-add">{r.totals.added}</strong></div></div>
        <div><span className="stat-label">Removed</span><div><strong className="c-rem">{r.totals.removed}</strong></div></div>
        <div><span className="stat-label">Modified</span><div><strong className="c-mod">{r.totals.modified}</strong></div></div>
      </div>
      {r.risk.reasons.length ? <ul className="reasons">{r.risk.reasons.slice(0, 5).map((x) => <li key={x.message}>{x.message}</li>)}</ul> : null}
      <ul className="reasons">
        <li>A pre-restore backup is created and verified first. If it fails, nothing is changed.</li>
        <li>The system goes into maintenance mode and is unavailable to everyone until the restore ends.</li>
        <li>Audit history and backup history are preserved.</li>
      </ul>
      {r.risk.level === 'HIGH' ? <label className="check"><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> I understand the risk and want to continue</label> : null}
    </ReauthDialog>
  );
}

export default function RestoreTab({ onRestoreStarted }) {
  const toast = useToast();
  const [analysis, setAnalysis] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [pct, setPct] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const id = analysis && analysis.id;
  const running = analysis && analysis.status === 'running';

  useEffect(() => {
    if (!running) return undefined;
    const t = setInterval(async () => {
      try { setAnalysis((await get(`/api/admin/backups/analyses/${id}`)).analysis); } catch (e) { toast(e.message, 'err'); setAnalysis(null); }
    }, 1000);
    return () => clearInterval(t);
  }, [running, id, toast]);

  const analyze = async (file) => {
    setUploading(true); setPct(0); setAnalysis(null);
    try { setAnalysis((await uploadZip(file, setPct)).analysis); } catch (e) { toast(e.message, 'err'); } finally { setUploading(false); }
  };
  const discard = async () => {
    try { await api('DELETE', `/api/admin/backups/analyses/${id}`); } catch (_) { /* already expired */ }
    setAnalysis(null);
  };

  return (
    <>
      <div className="alert info mb-12">Upload a backup to see exactly what a restore would change, before anything is touched. This analysis never modifies the live system.</div>
      <UploadCard busy={uploading || Boolean(running)} uploadPct={pct} onAnalyze={analyze} />
      {running ? <div className="card mb-12"><div className="card-pad"><strong>Analyzing…</strong> <span className="dim">{analysis.stage}</span></div></div> : null}
      {analysis && analysis.status === 'failed' ? <div className="alert err mb-12">Analysis failed: {analysis.error}</div> : null}
      {analysis && analysis.status === 'done' ? <Report a={analysis} onDiscard={discard} onRestore={() => setConfirming(true)} /> : null}
      {confirming && analysis ? <RestoreDialog a={analysis} onClose={() => setConfirming(false)} onStarted={(jobId) => { setConfirming(false); setAnalysis(null); onRestoreStarted(jobId); }} /> : null}
    </>
  );
}
