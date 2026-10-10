import { Fragment, useEffect, useState } from 'react';
import { get } from '../../lib/api.js';
import { fmtBytes, fmtDateTime } from '../../lib/util.js';
import { Empty, useDebounced } from '../../components/ui.jsx';

const PAGE = 50;

const ACTION_LABELS = {
  'auth.login': 'User Login',
  'auth.logout': 'User Logout',
  'auth.login_failed': 'Failed Login',
  'auth.locked': 'Account Locked',
  'auth.login_blocked_locked': 'Login Blocked (Locked Account)',

  'ingest.create': 'Created Ingest Record',
  'ingest.export': 'Exported Ingest Records',
  'ingest.import': 'Imported Ingest Records',
  'workload.plugs_export': 'Exported Plug List',
  'ingest.update': 'Updated Ingest Record',
  'ingest.delete': 'Deleted Ingest Record',
  'ingest.edit_blocked': 'Ingest Edit Refused (CM Locked)',
  'ingest.delete_blocked': 'Ingest Delete Refused',
  'ingest.send_for_approval': 'Submitted For Approval',
  'ingest.approve': 'Approved Ingest Record',
  'ingest.unapprove': 'Removed Ingest Approval',
  'ingest.cm_reset': 'CM Status Set To Pending',
  'ingest.cm_done': 'CM Completed',
  'ingest.cm_non_compliant': 'CM Marked Non-Compliant',

  'approval.approved': 'Approved Request',
  'approval.rejected': 'Rejected Request',

  'admin.user_unlock': 'Unlocked User',

  'admin.user_create': 'Created User',
  'admin.user_update': 'Updated User',
  'admin.user_reset_password': 'Reset Password',
  'admin.user_reset_2fa': 'Reset 2FA',

  'admin.group_create': 'Created Group',
  'admin.group_update': 'Updated Group',
  'admin.group_delete': 'Deleted Group',

  'admin.role_create': 'Created Role',
  'admin.role_update': 'Updated Role',
  'admin.role_delete': 'Deleted Role',
  'admin.dropdown_create': 'Created Dropdown',
  'admin.dropdown_update': 'Updated Dropdown',
  'admin.dropdown_delete': 'Deleted Dropdown',
  'admin.user_delete': 'Deleted User',
  'admin.dropdown_export': 'Exported Dropdowns',
  'admin.dropdown_import': 'Imported Dropdowns',

  'admin.branding_update': 'Updated Branding',
  'admin.branding_logo': 'Uploaded Logo',
  'admin.branding_logo_remove': 'Removed Logo',

  'workload.create': 'Created Workload Item',
  'workload.update': 'Updated Workload Item',
  'workload.delete': 'Deleted Workload Item',
  'workload.export': 'Exported Workload',
  'workload.export_failed': 'Workload Export Failed',
  'workload.import': 'Imported Workload',
  'workload.import_failed': 'Workload Import Failed',
  'workload.bulk_delete': 'Bulk-Deleted Workload Items',
  'workload.plugs_import': 'Imported Plug List',
  'workload.plugs_import_failed': 'Plug List Import Failed',
  'workload.plugs_copy': 'Copied Plugs to Workload',
  'workload.plugs_fill': 'Filled Workload from Plug List',
  'workload.plugs_delete_all': 'Deleted Plug List Entries',
  'workload.plug_add': 'Added Plug',
  'workload.plug_edit': 'Edited Plug',
  'workload.plug_delete': 'Deleted Plug',

  'profile.update': 'Updated Profile',  
  'profile.password_change': 'Password Changed',

  'auth.2fa_failed': '2FA Verification Failed',
  'auth.reauth_failed': 'Identity Confirmation Failed',
  'profile.2fa_enable': 'Enabled 2FA',
  'profile.2fa_disable': 'Disabled 2FA',
  
  'knowledge.seed': 'Seeded Knowledge Document',
  'knowledge.upload': 'Uploaded Knowledge Document',
  'knowledge.rename': 'Renamed Knowledge Document',
  'knowledge.delete': 'Moved Knowledge Document to Trash',
  'knowledge.restore': 'Restored Knowledge Document',
  'knowledge.purge': 'Permanently Deleted Knowledge Document',

  'admin.workload_column_add': 'Added Workload Column',
  'admin.workload_column_delete': 'Deleted Workload Column',
  'admin.workload_lock_add': 'Added Workload Lock',
  'admin.workload_lock_delete': 'Deleted Workload Lock',

  'admin.backup_create': 'Created Backup',
  'admin.backup_download': 'Downloaded Backup',
  'admin.backup_delete': 'Deleted Backup',
  'admin.backup_verify': 'Verified Backup',
  'admin.backup_analyze': 'Verified Backup',
  'admin.backup_restore': 'Restored Backup',
  'admin.backup_schedule': 'Changed Backup Schedule',
  'admin.backup_scheduled': 'Scheduled Backup',
  'admin.user_bulk': 'Changed Several Users',
  'admin.user_signout': 'Signed User Out',
  'admin.dropdown_merge': 'Merged Dropdown Options',
  'admin.dropdown_bulk_add': 'Added Dropdown Options',
  'admin.audit_export': 'Exported Audit Log',
  'admin.security_update': 'Changed Security Rules',
  'admin.force_password_change': 'Forced Password Change',
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
    case 'role':
      return 'Role';
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
    case 'workload_transfer':
      return 'Workload / Plug List';
    case 'workload_plug':
      return 'Plug List Entry';  
    case 'knowledge_document':
    case 'knowledge_docs':  
      return 'Knowledge Document';
    case 'workload_lock':
      return 'Workload Lock';      
    case 'backup':
      return 'Backup';
     
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

function describeBackup(action, d) {
  const verb = { 'admin.backup_create': 'create', 'admin.backup_download': 'download', 'admin.backup_delete': 'delete', 'admin.backup_verify': 'verify', 'admin.backup_analyze': 'verify', 'admin.backup_restore': 'restore' }[action];
  const file = d.filename ? ` ${d.filename}` : '';
  if (action === 'admin.backup_analyze' && d.source === 'upload') {
    if (d.outcome === 'failed' && !d.riskLevel) return `Restore analysis failed${d.error ? `: ${d.error}` : ''}`;
    return `Analyzed uploaded backup${file} - risk ${d.riskLevel || 'n/a'}${d.blockers && d.blockers.length ? ` (blocked: ${d.blockers[0]})` : ''}`;
  }
  if (d.outcome === 'denied') return `Backup ${verb} denied${d.reason ? ` (${d.reason.replace(/_/g, ' ')})` : ''}${file ? ` -${file}` : ''}`;
  if (d.outcome === 'failed') return `Backup ${verb} failed${d.error ? `: ${d.error}` : ''}`;
  const size = d.sizeBytes != null ? ` (${fmtBytes(d.sizeBytes)})` : '';
  switch (action) {
    case 'admin.backup_create': return `Created backup${file}${size}`;
    case 'admin.backup_download': return `Downloaded backup${file}${size}`;
    case 'admin.backup_delete': return `Deleted backup${file}${size}`;
    case 'admin.backup_verify':
    case 'admin.backup_analyze': return `Verified backup${file} - signature: ${d.signature || 'n/a'}, checksums ${d.checksumsValid ? 'valid' : 'invalid'}`;
    default: return `Restored backup${file}`;
  }
}

// Small helpers for the import / export lines
const n = (count, one, many) => `${count || 0} ${(count || 0) === 1 ? one : (many || `${one}s`)}`;
const fileOf = (d) => (d.file ? ` "${d.file}"` : '');
const teamOf = (d) => (d.team && d.team !== 'ALL' ? ` (${d.team})` : '');
const rangeOf = (d) => (d.from ? ` (${String(d.from).slice(0, 10)}${d.to && String(d.to).slice(0, 10) !== String(d.from).slice(0, 10) ? ` to ${String(d.to).slice(0, 10)}` : ''})` : '');
const filtersOf = (f) => {
  const parts = Object.entries(f || {}).filter(([k, val]) => val != null && val !== '' && !['limit', 'offset', 'today'].includes(k)).map(([k, val]) => `${k}: ${val}`);
  return parts.length ? `, filtered by ${parts.join(', ')}` : '';
};

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

    case 'admin.user_bulk':
      return `${({ activate: 'Activated', deactivate: 'Deactivated', role: `Set role to ${d.role}`, group: d.group_id ? 'Changed group' : 'Removed from group',
        'reset-2fa': 'Reset 2FA for', 'sign-out': 'Signed out', unlock: 'Unlocked' })[d.action] || d.action} ${n(d.count, 'user')}${d.users && d.users.length ? `: ${d.users.slice(0, 5).join(', ')}${d.users.length > 5 ? '…' : ''}` : ''}`;

    case 'admin.user_signout':
      return `Signed ${d.username || 'user'} out of ${n(d.sessions, 'device')}`;

    case 'admin.dropdown_merge':
      return `Merged "${d.from}" into "${d.into}" (${d.category}) — ${n(d.moved, 'record')} updated`;

    case 'admin.dropdown_bulk_add':
      return `Added ${n(d.added, 'option')} to ${d.category}${d.skipped ? `, ${d.skipped} already existed` : ''}`;

    case 'admin.security_update': {
      const L = { minPasswordLength: 'min password', lockAfterFailures: 'lock after', lockMinutes: 'lock minutes', idleSignOutHours: 'idle hours', maxSessionHours: 'max session hours', requireAdmin2fa: 'Admin 2FA' };
      const ch = Object.keys(L).filter((k) => d.from && d.to && d.from[k] !== d.to[k]).map((k) => `${L[k]}: ${d.from[k]} → ${d.to[k]}`);
      return ch.length ? ch.join('; ') : 'Saved without changes';
    }

    case 'admin.force_password_change':
      return `${n(d.users, 'user')} must choose a new password at next sign-in`;

    case 'admin.audit_export':
      return `Exported ${n(d.rows, 'entry', 'entries')}${d.truncated ? ' (stopped at the limit)' : ''}`;

    case 'admin.backup_schedule':
      return `Schedule: ${d.to && d.to.mode === 'off' ? 'off' : `${d.to && d.to.mode} at ${d.to && d.to.time}`}, keep ${d.to && d.to.keep}`;

    case 'admin.backup_scheduled':
      return d.outcome === 'failed' ? `Scheduled backup could not start: ${d.error || ''}` : `Scheduled ${d.mode || ''} backup started`;

    case 'admin.dropdown_create':
      return `Created ${d.category}: ${d.value}`;

    case 'admin.dropdown_update':
      return `Updated ${d.to?.value || ''}`;

    case 'admin.dropdown_delete':
      return `Deleted ${d.category}: ${d.value}`;

    case 'admin.dropdown_export':
      return `Exported ${d.options} dropdown option(s) to JSON`;

    case 'admin.dropdown_import':
      return `Imported dropdowns from JSON: ${d.added} added, ${d.updated} updated, ${d.unchanged} unchanged`;

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

    case 'admin.role_create':
      return `Created role: ${d.name || ''}${d.actions && d.actions.length ? ` (can: ${d.actions.join(', ')})` : ''}`;

    case 'admin.role_update': {
      const parts = [];
      if (d.renamedFrom) parts.push(`renamed from ${d.renamedFrom}`);
      if (d.added && d.added.length) parts.push(`added: ${d.added.join(', ')}`);
      if (d.removed && d.removed.length) parts.push(`removed: ${d.removed.join(', ')}`);
      return `Updated role ${d.name || ''}${parts.length ? ` — ${parts.join('; ')}` : ' (no change to actions)'}`;
    }

    case 'admin.role_delete':
      return `Deleted role: ${d.name || ''}`;

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

    case 'ingest.update': {
      const L = { program: 'PROG. NAME / PROJ. TITLE', billable_party: 'Billable Party', platform: 'Platform', episode_break_date_text: 'Episode / Breakdate', materials_count: 'No. of Materials', source: 'Source', destination_folder: 'Destination Folder', remarks: 'Remarks' };
      const show = (x) => (x == null || x === '' ? '(empty)' : String(x).length > 60 ? `${String(x).slice(0, 57)}…` : String(x));
      const ch = d.changes && typeof d.changes === 'object' ? Object.entries(d.changes) : [];
      const list = ch.map(([k, c2]) => `${L[k] || k}: ${show(c2 && c2.from)} → ${show(c2 && c2.to)}`).join('; ');
      return `Updated ingest record${d.program ? ` (${d.program})` : ''}${list ? ` — ${list}` : ''}`;
    }

    case 'ingest.import':
      return `Imported ingest records from ${d.file || 'Excel'} — ${d.created ?? 0} added${d.existing ? `, ${d.existing} already there` : ''}${d.skipped ? `, ${d.skipped} skipped` : ''}`;

    case 'ingest.export':
      return `Exported ${d.rows ?? ''} ingest record(s) to Excel${d.truncated ? ' (stopped at 20,000 rows)' : ''}`;

    case 'workload.plugs_export':
      return `Exported ${d.rows ?? ''} plug list row(s) to Excel${d.truncated ? ' (stopped at 20,000 rows)' : ''}`;

    case 'ingest.delete':
      return `Deleted ingest record${d.program ? ` (${d.program})` : ''}${d.cm_status ? ` — CM status was ${d.cm_status}` : ''}${d.batch ? ' (batch delete)' : ''}`;

    case 'ingest.edit_blocked':
      return `Edit refused: ingest record${d.program ? ` (${d.program})` : ''} is ${d.cm_status || 'locked'} in CM${d.field ? ` (tried to change ${d.field})` : ''}`;

    case 'ingest.delete_blocked':
      return `Delete refused for ingest record${d.program ? ` (${d.program})` : ''} — ${d.reason || 'not allowed'}${d.batch ? ' (batch delete)' : ''}`;

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

    case 'auth.reauth_failed':
      return `Wrong password or code when confirming: ${formatAction(d.for || '') || 'a sensitive action'}`;

    case 'profile.2fa_enable':
      return 'Two-factor authentication enabled';

    case 'profile.2fa_disable':
      return 'Two-factor authentication disabled';    
      
    case 'knowledge.seed':
      return `Seeded knowledge document: ${d.filename || ''}`;

    case 'knowledge.upload':
      return `Uploaded knowledge document: ${d.title || d.filename || ''}${Array.isArray(d.tags) && d.tags.length ? ` · tags: ${d.tags.join(', ')}` : ''}`;

    case 'knowledge.rename':
      return `${d.title ? `Renamed knowledge document to: ${d.title}` : 'Changed knowledge document'}${Array.isArray(d.tags) ? ` · tags: ${d.tags.join(', ') || 'none'}` : ''}`;

    case 'knowledge.delete':
      return `Moved knowledge document to Trash: ${d.title || d.filename || ''}`;

    case 'knowledge.restore':
      return `Restored knowledge document from Trash: ${d.title || d.filename || ''}`;

    case 'knowledge.purge':
      return `Permanently deleted knowledge document: ${d.title || d.filename || ''}`;

    case 'ingest.approve':
      return 'Approved ingest request';

    case 'ingest.unapprove':
      return 'Removed the approval on an ingest request';

    case 'ingest.cm_reset':
      return 'Set ingest request status back to Pending';

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
      
    case 'admin.workload_lock_add':
      return `Locked workload dates from ${d.from_date} to ${d.to_date}${d.note ? ` (${d.note})` : ''}`;

    case 'admin.workload_lock_delete':
      return `Removed workload date lock from ${d.from_date} to ${d.to_date}`;  
      
    case 'admin.backup_create':
    case 'admin.backup_download':
    case 'admin.backup_delete':
    case 'admin.backup_verify':
    case 'admin.backup_analyze':
    case 'admin.backup_restore':
      return describeBackup(row.action, d);

    case 'workload.export':
      return `Exported ${n(d.matched, 'row')}${teamOf(d)}${fileOf(d)}${d.truncated ? ' (stopped at the 20,000-row limit)' : ''}${filtersOf(d.filters)}`;

    case 'workload.export_failed':
      return `Workload export failed${teamOf(d)}: ${d.error || 'unknown error'}`;

    case 'workload.import':
      return `Imported${fileOf(d)}: ${n(d.created, 'row')} added, ${d.skipped || 0} skipped`
        + `${Array.isArray(d.newColumns) && d.newColumns.length ? `; new columns: ${d.newColumns.join(', ')}` : ''}`
        + `${Array.isArray(d.errors) && d.errors.length ? `; first problem: ${d.errors[0]}` : ''}`;

    case 'workload.import_failed':
      return `Workload import failed${fileOf(d)}: ${d.error || 'unknown error'}`;

    case 'workload.bulk_delete':
      return `Deleted ${n(d.deleted, 'workload row')}${d.skippedLocked ? `, ${d.skippedLocked} locked and kept` : ''}${filtersOf(d.filters)}`;

    case 'workload.plugs_import':
      return `Imported plug list${fileOf(d)}: ${n(d.plugs, 'plug')} over ${n(d.days, 'day')}${rangeOf(d)}, ${d.added || 0} new`
        + `${d.skipped ? `, ${d.skipped} skipped` : ''}${d.workloadRowsFilled ? `; filled ${n(d.workloadRowsFilled, 'workload row')}` : ''}`;

    case 'workload.plugs_import_failed':
      return `Plug list import failed${fileOf(d)}: ${d.error || 'unknown error'}`;

    case 'workload.plugs_copy':
      return `Copied ${n(d.created, 'plug')} to the Workload Tracker${rangeOf(d)}`
        + `${d.alreadyInWorkload ? `, ${d.alreadyInWorkload} already there` : ''}${d.skippedLocked ? `, ${d.skippedLocked} on locked days` : ''}`;

    case 'workload.plugs_fill':
      return `Filled PSD / Prog. Name on ${n(d.rowsFilled, 'workload row')}${rangeOf(d)}`;

    case 'workload.plugs_delete_all':
      return `Deleted ${n(d.deleted, 'plug list entry', 'plug list entries')}${d.scope === 'all' ? ' (the whole list)' : filtersOf(d.filters)}`;

    case 'workload.plug_add':
    case 'workload.plug_edit':
    case 'workload.plug_delete':
      return `${{ 'workload.plug_add': 'Added', 'workload.plug_edit': 'Edited', 'workload.plug_delete': 'Deleted' }[row.action]} plug ${d.plug_id || ''}${d.plug_date ? ` (${String(d.plug_date).slice(0, 10)})` : ''}`;

    case 'auth.locked':
      return 'Account locked due to multiple failed login attempts';

    case 'auth.login_blocked_locked':
      return 'Login blocked because account is currently locked';     

    case 'admin.user_unlock':
      return `Unlocked user: ${d.username || ''}`;      

    default:
      return '';
  }
}



// Where "Open" takes you for a record type. Only pages that exist; others show no link.
const RECORD_LINK = {
  user: '/admin#users', group: '/admin#access', role: '/admin#access', dropdown_option: '/admin#dropdowns', backup: '/admin#backup',
  ingest_record: '/ingest', approval_request: '/ingest', workload_item: '/workload', workload_plug: '/plug-list', knowledge_document: '/knowledge', knowledge_docs: '/knowledge',
};
const CATEGORIES = [['', 'Everything'], ['auth', 'Sign-ins'], ['ingest', 'Ingest'], ['approval', 'Approvals'], ['workload', 'Workload'], ['knowledge', 'Knowledge Base'], ['admin', 'Admin changes'], ['profile', 'Profile']];

const show = (x) => (x == null || x === '' ? '—' : typeof x === 'object' ? JSON.stringify(x) : String(x));
/** Readable before / after: a {from, to} pair of objects becomes one row per changed field; everything else is a field list. */
function Expanded({ row }) {
  const d = row.details;
  if (!d || typeof d !== 'object') return <span className="dim">No more detail was recorded.</span>;
  const from = d.from && typeof d.from === 'object' ? d.from : null;
  const to = d.to && typeof d.to === 'object' ? d.to : null;
  if (from && to) {
    const keys = [...new Set([...Object.keys(from), ...Object.keys(to)])].filter((k) => JSON.stringify(from[k]) !== JSON.stringify(to[k]));
    const rest = Object.entries(d).filter(([k]) => k !== 'from' && k !== 'to');
    return (
      <>
        <table className="t audit-diff">
          <thead><tr><th>Field</th><th>Before</th><th>After</th></tr></thead>
          <tbody>{keys.length ? keys.map((k) => <tr key={k}><td>{USER_FIELD_LABELS[k] || k}</td><td className="was">{show(from[k])}</td><td className="now">{show(to[k])}</td></tr>)
            : <tr><td colSpan={3} className="dim">Nothing changed.</td></tr>}</tbody>
        </table>
        {rest.length ? <dl className="audit-fields">{rest.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{show(v)}</dd></div>)}</dl> : null}
      </>
    );
  }
  return <dl className="audit-fields">{Object.entries(d).map(([k, v]) => <div key={k}><dt>{USER_FIELD_LABELS[k] || k}</dt><dd>{show(v)}</dd></div>)}</dl>;
}

export default function Audit() {
  const isActivityHistory =
    window.location.pathname === '/activity-history';

  const [f, setF] = useState({ action: '', category: '', user: '', q: '', record: '', from: '', to: '' });
  const [offset, setOffset] = useState(0);
  const [d, setD] = useState(null);
  const [open, setOpen] = useState(() => new Set());
  const action = useDebounced(f.action);
  const user = useDebounced(f.user);
  const q = useDebounced(f.q);
  const record = useDebounced(f.record);

  const params = () => {
    const p = new URLSearchParams();
    Object.entries({ action, category: f.category, user, q, record, from: f.from, to: f.to }).forEach(([k, v]) => { if (v) p.set(k, v); });
    return p;
  };

  useEffect(() => {
    const p = params(); p.set('limit', PAGE); p.set('offset', offset);
    const endpoint =
      window.location.pathname === '/activity-history'
        ? '/api/profile/activity-history'
        : '/api/admin/audit';

    get(`${endpoint}?${p}`)
      .then((data) => {
        setD(data); setOpen(new Set());
      })
      .catch(() => setD({ rows: [], total: 0 }));
  }, [action, f.category, user, q, record, f.from, f.to, offset]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (k) => (e) => { setF((x) => ({ ...x, [k]: e.target.value })); setOffset(0); };
  const total = d ? d.total : 0;
  const any = Object.values(f).some(Boolean);
  const toggle = (id) => setOpen((o) => { const n2 = new Set(o); if (n2.has(id)) n2.delete(id); else n2.add(id); return n2; });

  return (
    <div className="card">

      <div className="filters">
        <input
          type="search"
          placeholder={
            isActivityHistory
              ? 'Search activity'
              : 'Action contains…'
          }
          value={f.action}
          onChange={set('action')}
        />

        {!isActivityHistory && (
          <>
            <select aria-label="Kind of activity" value={f.category} onChange={set('category')}>{CATEGORIES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
            <input type="search" placeholder="Username" value={f.user} onChange={set('user')} />
            <input type="search" placeholder="Search inside details" value={f.q} onChange={set('q')} />
            <input type="search" placeholder="Record #" value={f.record} onChange={set('record')} className="narrow" aria-label="Record number" />
          </>
        )}

        <input
          type="date"
          value={f.from}
          aria-label="From date"
          onChange={set('from')}
        />

        <input
          type="date"
          value={f.to}
          aria-label="To date"
          onChange={set('to')}
        />
        {any ? <button type="button" className="btn sm ghost" onClick={() => { setF({ action: '', category: '', user: '', q: '', record: '', from: '', to: '' }); setOffset(0); }}>Clear</button> : null}
        {!isActivityHistory ? <a className="btn sm" href={`/api/admin/audit/export?${params()}`} download>Export to Excel</a> : null}
      </div>


      <div className="table-wrap">
        {!d ? <Empty>Loading…</Empty> : !d.rows.length ? <Empty>No audit entries.</Empty> : (
          <table className="t wl audit-t">
            <thead><tr><th className="chk" /><th>Time</th><th>User</th><th>Action</th><th>Entity</th><th>Details</th><th>IP</th></tr></thead>
            <tbody>
              {d.rows.map((r) => {
                const details = r.details ? JSON.stringify(r.details) : '';
                const isOpen = open.has(r.id);
                const link = r.entity && RECORD_LINK[r.entity];
                return (
                  <Fragment key={r.id}>
                    <tr className={isOpen ? 'audit-open' : ''}>
                      <td className="chk">
                        {details ? <button type="button" className="exp" aria-expanded={isOpen} aria-label={isOpen ? 'Hide detail' : 'Show detail'} onClick={() => toggle(r.id)}>{isOpen ? '▾' : '▸'}</button> : null}
                      </td>
                      <td className="nowrap dim">{fmtDateTime(r.created_at)}</td>
                      <td className="mono">{r.username || '—'}</td>

                      <td>{formatAction(r.action)}</td>

                      <td className="nowrap">
                        {formatEntity(r)}
                        {r.entity_id ? (
                          <> <button type="button" className="linklike mono" title="Show everything about this record" onClick={() => { if (!isActivityHistory) { setF((x) => ({ ...x, record: r.entity_id })); setOffset(0); } }}>#{r.entity_id}</button></>
                        ) : null}
                        {link && !isActivityHistory ? <> <a className="linklike" href={link}>Open</a></> : null}
                      </td>

                      <td title={details}>
                        {formatDetails(r)}
                      </td>

                      <td className="mono dim">{r.ip || ''}</td>
                    </tr>
                    {isOpen ? <tr className="audit-more"><td /><td colSpan={6}><Expanded row={r} /></td></tr> : null}
                  </Fragment>
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
