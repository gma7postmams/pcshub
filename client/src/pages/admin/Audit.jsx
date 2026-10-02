import { useEffect, useState } from 'react';
import { get } from '../../lib/api.js';
import { fmtDateTime } from '../../lib/util.js';
import { Empty, useDebounced } from '../../components/ui.jsx';

const PAGE = 50;

const ACTION_LABELS = {
  'auth.login': 'User Login',
  'auth.logout': 'User Logout',
  'auth.login_failed': 'Failed Login',

  'ingest.create': 'Created Ingest Record',
  'ingest.send_for_approval': 'Submitted For Approval',
  'ingest.cm_done': 'CM Completed',
  'ingest.cm_non_compliant': 'CM Marked Non-Compliant',

  'approval.approved': 'Approved Request',
  'approval.rejected': 'Rejected Request',

  'admin.user_create': 'Created User',
  'admin.user_update': 'Updated User',
  'admin.user_reset_password': 'Reset Password',
  'admin.user_reset_2fa': 'Reset 2FA',

  'admin.group_create': 'Created Group',
  'admin.group_update': 'Updated Group',
  'admin.group_delete': 'Deleted Group',

  'admin.dropdown_create': 'Created Dropdown',
  'admin.dropdown_update': 'Updated Dropdown',
  'admin.dropdown_delete': 'Deleted Dropdown',

  'admin.branding_update': 'Updated Branding',
  'admin.branding_logo': 'Uploaded Logo',
  'admin.branding_logo_remove': 'Removed Logo',

  'workload.create': 'Created Workload Item',
  'workload.update': 'Updated Workload Item',
  'workload.delete': 'Deleted Workload Item',

  'profile.update': 'Updated Profile',  
  'profile.password_change': 'Password Changed',

  'auth.2fa_failed': '2FA Verification Failed',
  'profile.2fa_enable': 'Enabled 2FA',
  'profile.2fa_disable': 'Disabled 2FA',
  
  'knowledge.seed': 'Seeded Knowledge Document',
  'knowledge.upload': 'Uploaded Knowledge Document',
  'knowledge.rename': 'Renamed Knowledge Document',
  'knowledge.delete': 'Deleted Knowledge Document',

  'admin.workload_column_add': 'Added Workload Column',
  'admin.workload_column_delete': 'Deleted Workload Column',

};

function formatAction(action) {
  return ACTION_LABELS[action] || action;
}

function formatEntity(row) {
  switch (row.entity) {
    case 'user':
      return 'User';
    case 'group':
      return 'Group';
    case 'dropdown_option':
      return 'Dropdown';
    case 'approval_request':
      return 'Approval Request';
    case 'ingest_record':
      return 'Ingest Record';
    case 'app_settings':
      return 'Application Branding';
    case 'report':
      return 'Report';
    case 'workload_item':
      return 'Workload Item';  
    case 'knowledge_document':
    case 'knowledge_docs':  
      return 'Knowledge Document';
     
    default:
      return row.entity || '';
  }
}

const USER_FIELD_LABELS = {
  full_name: 'Full Name',
  email: 'Email',
  role: 'Role',
  group_id: 'Group',
  is_active: 'Status',
};

function describeUserUpdate(d) {
  const from = d.from || {};
  const to = d.to || {};

  const show = (k, val, side) => {
    if (k === 'is_active') return val ? 'Active' : 'Inactive';
    if (k === 'group_id') return side.group ?? (val == null ? 'none' : `#${val}`);
    return val == null || val === '' ? 'none' : String(val);
  };

  const labels = {
    full_name: 'Full Name',
    email: 'Email',
    role: 'Role',
    group_id: 'Group',
    is_active: 'Status',
  };

  const changes = Object.keys(labels)
    .filter((k) => k in to && (from[k] ?? null) !== (to[k] ?? null))
    .map(
      (k) =>
        `${labels[k]} changed from "${show(k, from[k], from)}" to "${show(k, to[k], to)}"`
    );

  return changes.length
    ? changes.join(' | ')
    : 'Updated user settings';
}

function describeBrandingUpdate(d) {
  if (!d.to) return `Updated branding theme: ${d.theme || ''}`; // legacy records
  const from = d.from || {};
  const labels = {
    app_name: 'Application Name',
    tagline: 'Tagline',
    theme: 'Theme',
    accent_color: 'Accent Color',
  };
  const q = (v) => (v == null || v === '' ? 'none' : `"${v}"`);
  const changes = Object.keys(labels)
    .filter((k) => k in d.to && (from[k] ?? '') !== (d.to[k] ?? ''))
    .map((k) => `${labels[k]} changed from ${q(from[k])} to ${q(d.to[k])}`);
  return changes.length ? changes.join(' | ') : 'Updated branding settings (no changes)';
}

function formatDetails(row) {
  const d = row.details || {};

  switch (row.action) {
    case 'auth.login':
      return 'User logged in successfully';

    case 'auth.logout':
      return 'User logged out';

    case 'auth.login_failed':
      if (d.reason === 'unknown_user') {
        return `Unknown username: ${d.username || ''}`;
      }
      if (d.reason === 'bad_password') {
        return `Invalid password for ${d.username || 'user'}`;
      }
      if (d.reason === 'locked') {
        return `Account locked: ${d.username || 'user'}`;
      }
      return 'Login attempt failed';

    case 'admin.dropdown_create':
      return `Created ${d.category}: ${d.value}`;

    case 'admin.dropdown_update':
      return `Updated ${d.to?.value || ''}`;

    case 'admin.dropdown_delete':
      return `Deleted ${d.category}: ${d.value}`;

    case 'admin.branding_update':
      return describeBrandingUpdate(d);

    case 'admin.branding_logo':
      return 'Uploaded application logo';

    case 'admin.branding_logo_remove':
      return 'Removed application logo';

    case 'admin.user_create':
      return `Created user: ${d.username || ''}`;

    case 'admin.user_update':
      return describeUserUpdate(d);

    case 'admin.user_reset_password':
      return 'Password reset';

    case 'admin.user_reset_2fa':
      return '2FA reset';

    case 'admin.group_create':
      return `Created group: ${d.name || ''}`;

    case 'admin.group_update':
      return 'Updated group permissions';

    case 'admin.group_delete':
      return `Deleted group: ${d.name || ''}`;

    case 'ingest.create':
      return d.program
        ? `Created ingest record (${d.program})`
        : d.title
          ? `Created ingest record (${d.title})`
          : 'Created ingest record';

    case 'ingest.send_for_approval':
      return d.program
        ? `Submitted ingest record "${d.program}" for approval`
        : d.title
          ? `Submitted ingest record "${d.title}" for approval`
          : 'Submitted ingest record for approval';

    case 'approval.approved':
      return d.note
        ? `Approved ingest request${d.title ? `: ${d.title}` : ''} - Note: ${d.note}`
        : `Approved ingest request${d.title ? `: ${d.title}` : ''}`;

    case 'approval.rejected':
      return d.note
        ? `Rejected ingest request${d.title ? `: ${d.title}` : ''} - Reason: ${d.note}`
        : `Rejected ingest request${d.title ? `: ${d.title}` : ''}`;

    case 'reports_export_ingest':
    case 'reports.export_ingest':
      return 'Exported ingest report';

    case 'workload.create':
      return d.title
        ? `Created workload item (${d.title})`
        : 'Created workload item';

    case 'workload.update':
      return d.title
        ? `Updated workload item (${d.title})`
        : 'Updated workload item';

    case 'workload.delete':
      return d.title
        ? `Deleted workload item (${d.title})`
        : 'Deleted workload item';

    case 'profile.update': {
      const changes = [];

      if (d.old_full_name !== undefined && d.new_full_name !== undefined) {
        changes.push(
          `Full Name changed from "${d.old_full_name}" to "${d.new_full_name}"`
        );
      }

      if (d.old_email !== undefined && d.new_email !== undefined) {
        changes.push(
          `Email changed from "${d.old_email}" to "${d.new_email}"`
        );
      }

      return changes.length
        ? changes.join(' | ')
        : 'Updated profile information';
    }         

    case 'profile.password_change':
      return 'Password changed successfully';

    case 'auth.2fa_failed':
      return 'Invalid 2FA authentication code';

    case 'profile.2fa_enable':
      return 'Two-factor authentication enabled';

    case 'profile.2fa_disable':
      return 'Two-factor authentication disabled';    
      
    case 'knowledge.seed':
      return `Seeded knowledge document: ${d.filename || ''}`;

    case 'knowledge.upload':
      return `Uploaded knowledge document: ${d.filename || ''}`;

    case 'knowledge.rename':
      return `Renamed knowledge document to: ${d.title || ''}`;

    case 'knowledge.delete':
      return `Deleted knowledge document: ${d.title || d.filename || ''}`;

    case 'ingest.cm_done':
      return 'CM completed ingest request';

    case 'ingest.cm_non_compliant':
      return d.reason
        ? `Marked ingest request as NON-COMPLIANT - Reason: ${d.reason}`
        : 'Marked ingest request as NON-COMPLIANT';     
        
    case 'admin.workload_column_add':
      return `Added workload column: ${d.label || ''}`;

    case 'admin.workload_column_delete':
      return `Deleted workload column: ${d.label || ''}`;        

    default:
      return '';
  }
}



export default function Audit() {
  const isActivityHistory =
    window.location.pathname === '/activity-history';

  const [f, setF] = useState({ action: '', user: '', from: '', to: '' });
  const [offset, setOffset] = useState(0);
  const [d, setD] = useState(null);
  const action = useDebounced(f.action);
  const user = useDebounced(f.user);

  useEffect(() => {
    const p = new URLSearchParams({ limit: PAGE, offset });
    Object.entries({ action, user, from: f.from, to: f.to }).forEach(([k, v]) => { if (v) p.set(k, v); });
    const endpoint =
      window.location.pathname === '/activity-history'
        ? '/api/profile/activity-history'
        : '/api/admin/audit';

    get(`${endpoint}?${p}`)
      .then((data) => {
        setD(data);
      })
      .catch(() => setD({ rows: [], total: 0 }));
  }, [action, user, f.from, f.to, offset]);

  const set = (k) => (e) => { setF((x) => ({ ...x, [k]: e.target.value })); setOffset(0); };
  const total = d ? d.total : 0;

  return (
    <div className="card">

      <div className="filters">
        <input
          type="search"
          placeholder={
            isActivityHistory
              ? 'Search activity'
              : 'Action (e.g. ingest, approval, auth)'
          }
          value={f.action}
          onChange={set('action')}
        />

        {!isActivityHistory && (
          <input
            type="search"
            placeholder="Username"
            value={f.user}
            onChange={set('user')}
          />
        )}

        <input
          type="date"
          value={f.from}
          onChange={set('from')}
        />

        <input
          type="date"
          value={f.to}
          onChange={set('to')}
        />
      </div>


      <div className="table-wrap">
        {!d ? <Empty>Loading…</Empty> : !d.rows.length ? <Empty>No audit entries.</Empty> : (
          <table className="t">
            <thead><tr><th>Time</th><th>User</th><th>Action</th><th>Entity</th><th>Details</th><th>IP</th></tr></thead>
            <tbody>
              {d.rows.map((r) => {
                const details = r.details ? JSON.stringify(r.details) : '';
                return (
                  <tr key={r.id}>
                    <td className="nowrap dim">{fmtDateTime(r.created_at)}</td>
                    <td className="mono">{r.username || '—'}</td>

                    <td>{formatAction(r.action)}</td>

                    <td className="nowrap">
                      {formatEntity(r)}
                    </td>

                    <td title={details}>
                      {formatDetails(r)}
                    </td>

                    <td className="mono dim">{r.ip || ''}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      <div className="pager">
        <span>{total ? `${offset + 1}–${Math.min(offset + PAGE, total)} of ${total}` : ''}</span>
        <span className="grow" />
        <button type="button" className="btn sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Previous</button>
        <button type="button" className="btn sm" disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)}>Next</button>
      </div>
    </div>
  );
}
