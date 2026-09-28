// Access model
// ------------
// ROLE  (Admin | Manager | Editor | Viewer) -> what a user can DO (actions).
// GROUP (Admin-defined, one per user)       -> which pages / sections a user can OPEN.
//
// Effective rules:
//  - Admin role: every page and section, plus the Admin page. Group is ignored.
//  - Everyone else: only the pages/sections checked on their group. No group => Profile only.
//  - An action needs BOTH the role AND access to the page it happens on
//    (e.g. approving requires Manager role + a group with the Approval page).
//  - Profile is always available. Admin page is Admin-role only (not group-assignable).

const ROLES = ['Admin', 'Manager', 'Editor', 'Viewer'];

// Pages (and their sections) that a group can be granted. Keys are stored in group_permissions.
// A section is only effective if its page is also granted.
const CATALOG = [
  {
    key: 'dashboard', label: 'Dashboard', path: '/dashboard',
    sections: [
      { key: 'dashboard.kpis', label: 'Ingest KPIs' },
      { key: 'dashboard.recent', label: 'Recent ingest activity' },
    ],
  },
  { key: 'ingest', label: 'Ingest Tracker', path: '/ingest', sections: [] },
  { key: 'workload', label: 'Workload Tracker', path: '/workload', sections: [] },
  { key: 'approval', label: 'Approval', path: '/approval', sections: [] },
  {
    key: 'reports', label: 'Reports', path: '/reports',
    sections: [
      { key: 'reports.ingest', label: 'Ingest & Approval summary' },
      { key: 'reports.export', label: 'CSV export' },
    ],
  },
  { key: 'knowledge', label: 'Knowledge Base', path: '/knowledge', sections: [] },
];

const FIXED_PAGES = [
  { key: 'admin', label: 'Admin', path: '/admin', roleOnly: 'Admin' },
  { key: 'profile', label: 'Profile', path: '/profile', always: true, inNav: false },
];

const ALL_KEYS = CATALOG.flatMap((p) => [p.key, ...p.sections.map((s) => s.key)]);
const PAGE_BY_PATH = Object.fromEntries([...CATALOG, ...FIXED_PAGES].map((p) => [p.path, p]));
const SECTION_PAGE = Object.fromEntries(CATALOG.flatMap((p) => p.sections.map((s) => [s.key, p.key])));

// Role -> actions
const ROLE_ACTIONS = {
  Admin:   ['ingest.write', 'ingest.delete', 'approval.decide', 'workload.write', 'admin'],
  Manager: ['ingest.write', 'approval.decide', 'workload.write'],
  Editor:  ['ingest.write'],
  Viewer:  [],
};
// Action -> page the action happens on (the user's group must grant it)
const ACTION_PAGE = {
  'ingest.write': 'ingest',
  'ingest.delete': 'ingest',
  'approval.decide': 'approval',
  'workload.write': 'workload',
  'admin': null,
};

function isValidKey(k) { return ALL_KEYS.includes(k); }

/** Normalize a set of granted keys: drop unknowns, drop sections whose page is not granted. */
function normalizeKeys(keys) {
  const set = new Set((keys || []).filter(isValidKey));
  for (const k of [...set]) if (SECTION_PAGE[k] && !set.has(SECTION_PAGE[k])) set.delete(k);
  return [...set];
}

/** user: { role, perms: string[] } */
function effectiveKeys(user) {
  if (!user) return new Set();
  if (user.role === 'Admin') return new Set(ALL_KEYS);
  return new Set(normalizeKeys(user.perms));
}

function canPage(user, path) {
  const page = PAGE_BY_PATH[path];
  if (!page || !user) return false;
  if (page.always) return true;
  if (page.roleOnly) return user.role === page.roleOnly;
  return effectiveKeys(user).has(page.key);
}

function canSection(user, key) {
  return effectiveKeys(user).has(key);
}

function can(user, action) {
  if (!user || !(ROLE_ACTIONS[user.role] || []).includes(action)) return false;
  const pageKey = ACTION_PAGE[action];
  return !pageKey || effectiveKeys(user).has(pageKey);
}

function allowedPages(user) {
  const eff = effectiveKeys(user);
  const pages = CATALOG.filter((p) => eff.has(p.key)).map(({ key, label, path }) => ({ key, label, path }));
  if (user && user.role === 'Admin') pages.push({ key: 'admin', label: 'Admin', path: '/admin' });
  pages.push({ key: 'profile', label: 'Profile', path: '/profile', inNav: false });
  return pages;
}

function allowedSections(user) {
  const eff = effectiveKeys(user);
  return [...eff].filter((k) => SECTION_PAGE[k]);
}

function allowedActions(user) {
  return Object.keys(ACTION_PAGE).filter((a) => can(user, a));
}

function landingPath(user) {
  const first = allowedPages(user)[0];
  return first ? first.path : '/profile';
}

module.exports = {
  ROLES, CATALOG, FIXED_PAGES, ROLE_ACTIONS, ACTION_PAGE, PAGE_BY_PATH,
  normalizeKeys, canPage, canSection, can, allowedPages, allowedSections, allowedActions, landingPath,
};
