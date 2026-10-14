// Access model
// ------------
// ROLE  (Admin | Manager | Editor | Viewer) -> what a user can DO (actions).
// GROUP (Admin-defined, one per user)       -> which pages / sections a user can OPEN.
//
// Effective rules:
//  - Admin role: every page and section, plus the Admin page. Group is ignored.
//  - Everyone else: only the pages/sections checked on their group. No group => Profile only.
//  - An action needs BOTH the role AND access to the page it happens on
//    (e.g. filling Destination Folder / Approved by requires Manager role + a group with the Ingest Tracker page).
//  - Profile is always available. Admin page is Admin-role only (not group-assignable).

// System Admin: everything, including the whole Admin area. Admin: every page and action in the app, but in the Admin area only
// the Audit Log, Dropdowns and Branding (the page is called Settings for Admin, Administration for System Admin). Everyone else: what their role and group allow.
const SYSADMIN = 'System Admin';
const ROLES = [SYSADMIN, 'Admin', 'Manager', 'Editor', 'Ingest', 'Viewer'];
const isSysAdmin = (u) => Boolean(u && u.role === SYSADMIN);
const isAdminish = (u) => Boolean(u && (u.role === 'Admin' || u.role === SYSADMIN));   // may delete whole lists, delete DONE ingest rows, opens every page

// Pages (and their sections) that a group can be granted. Keys are stored in group_permissions.
// A section is only effective if its page is also granted.
const CATALOG = [
  {
    key: 'dashboard',
    label: 'Dashboard',
    path: '/dashboard',
    sections: [
      { key: 'dashboard.kpis', label: 'Ingest KPIs' },
      { key: 'dashboard.users', label: 'Active users' },
    ],
  },

  { key: 'ingest', label: 'Ingest Tracker', path: '/ingest', sections: [] },
  { key: 'plugs', label: 'PSD Daily Plug List', path: '/plug-list', sections: [] },
  {
    key: 'workload',
    label: 'Workload Tracker',
    path: '/workload',
    // Which tabs of the Workload Tracker the group sees. A group with the page but none of these ticked sees every tab (as before this existed).
    sections: [
      { key: 'workload.all', label: 'All Tab' },
      { key: 'workload.vgfx', label: 'VGFX Tab' },
      { key: 'workload.vedit', label: 'VEDIT Tab' },
      { key: 'workload.audio', label: 'Audio Tab' },
      { key: 'workload.prep', label: 'PREP Tab' },
    ],
  },

  {
    key: 'knowledge',
    label: 'Knowledge Base',
    path: '/knowledge',
    sections: [],
  },
];

const FIXED_PAGES = [
  { key: 'admin', label: 'Admin', path: '/admin', roleOnly: ['Admin', 'System Admin'] },
  { key: 'activity-history', label: 'Activity History', path: '/activity-history', action: 'activity.view' },
  { key: 'profile', label: 'Profile', path: '/profile', always: true, inNav: false },
];

const ALL_KEYS = CATALOG.flatMap((p) => [p.key, ...p.sections.map((s) => s.key)]);
// Lookup tables keyed by text that can come from a request are created without a prototype, so a key such as
// "__proto__" or "constructor" is simply absent instead of resolving to something inherited.
const dict = (entries) => Object.assign(Object.create(null), Object.fromEntries(entries));
const PAGE_BY_PATH = dict([...CATALOG, ...FIXED_PAGES].map((p) => [p.path, p]));
const SECTION_PAGE = dict(CATALOG.flatMap((p) => p.sections.map((s) => [s.key, p.key])));

// Role -> actions
const DEFAULT_ROLE_ACTIONS = Object.assign(Object.create(null), {
  'System Admin': [
    'ingest.write',
    'ingest.delete',
    'ingest.approve',
    'ingest.cm_complete',
    'workload.write',
    'knowledge.write',
    'plugs.write',
    'activity.view',
    'admin'
  ],
  Admin: [
    'ingest.write',
    'ingest.delete',
    'ingest.approve',
    'ingest.cm_complete',
    'workload.write',
    'knowledge.write',
    'plugs.write',
    'activity.view'
  ],

  Manager: [
    'ingest.write',
    'ingest.approve',
    'ingest.cm_complete',
    'workload.write',
    'plugs.write',
    'activity.view'
  ],   // no knowledge.write: only Admin / System Admin add, change or delete Knowledge Base documents; everyone with the page can open and download them
  Editor:  ['ingest.write', 'plugs.write', 'activity.view'],   // plugs.write: edit the PSD Daily Plug List (page access still comes from the group)
  Ingest:  ['ingest.cm_complete'],   // Ingest Tracker only: Status (CM) and its NON-COMPLIANT reason, nothing else
  Viewer:  [],
});
// The live role -> actions map. It starts from the built-in defaults and is replaced from the database (roles / role_actions,
// managed in Admin > Roles) at startup and after every change, in place, so every module that imported it sees the update.
const ROLE_ACTIONS = Object.assign(Object.create(null), JSON.parse(JSON.stringify(DEFAULT_ROLE_ACTIONS)));

// Action -> page the action happens on (the user's group must grant it)
const ACTION_PAGE = Object.assign(Object.create(null), {
  'ingest.write': 'ingest',
  'ingest.delete': 'ingest',
  'ingest.cm_complete': 'ingest',
  'ingest.approve': 'ingest',
  'workload.write': 'workload',
  'knowledge.write': 'knowledge',
  'plugs.write': 'plugs',
  'activity.view': null,
  'admin': null,
});

const ALL_ACTIONS = Object.keys(ACTION_PAGE);
const BUILTIN_ROLES = ['System Admin', 'Admin', 'Manager', 'Editor', 'Ingest', 'Viewer'];
const ADMIN_ONLY_ACTIONS = ['admin'];   // held by System Admin alone

/** rows: [{ name, actions: string[] }]. Admin always holds every action; unknown actions are dropped. */
function applyRoles(rows) {
  const names = rows.map((r) => r.name);
  for (const n of ['Admin', SYSADMIN]) if (!names.includes(n)) names.unshift(n);
  ROLES.splice(0, ROLES.length, ...names);
  for (const k of Object.keys(ROLE_ACTIONS)) delete ROLE_ACTIONS[k];
  for (const r of rows) ROLE_ACTIONS[r.name] = (r.actions || []).filter((a) => ALL_ACTIONS.includes(a));
  ROLE_ACTIONS[SYSADMIN] = [...ALL_ACTIONS];                       // System Admin is fixed: always everything
  const adminRow = rows.find((r) => r.name === 'Admin');          // Admin is editable (Admin > Roles), but never holds the Admin-area action
  ROLE_ACTIONS.Admin = adminRow ? ROLE_ACTIONS.Admin.filter((a) => !ADMIN_ONLY_ACTIONS.includes(a)) : DEFAULT_ROLE_ACTIONS.Admin.filter((a) => !ADMIN_ONLY_ACTIONS.includes(a));
}

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
  if (isAdminish(user)) return new Set(ALL_KEYS);
  const set = new Set(normalizeKeys(user.perms));
  if (set.has('workload') && !WORKLOAD_TAB_KEYS.some((k) => set.has(k))) WORKLOAD_TAB_KEYS.forEach((k) => set.add(k));   // no tab ticked = every tab
  return set;
}

const WORKLOAD_TAB_KEYS = ['workload.all', 'workload.vgfx', 'workload.vedit', 'workload.audio', 'workload.prep'];
const WORKLOAD_TAB_BY_KEY = { 'workload.all': 'ALL', 'workload.vgfx': 'VGFX', 'workload.vedit': 'VEDIT', 'workload.audio': 'AUDIO', 'workload.prep': 'PREP' };
/** The Workload Tracker tabs this person may open, in tab order: ['ALL', 'VGFX', 'VEDIT', 'AUDIO'] or fewer. */
function workloadTabs(user) {
  const eff = effectiveKeys(user);
  return WORKLOAD_TAB_KEYS.filter((k) => eff.has(k)).map((k) => WORKLOAD_TAB_BY_KEY[k]);
}

function canPage(user, path) {
  const page = PAGE_BY_PATH[path];
  if (!page || !user) return false;
  if (page.always) return true;
  if (page.action) return !!user && !isAdminish(user) && can(user, page.action);   // Admins read the Audit Log instead
  if (page.roleOnly) return [].concat(page.roleOnly).includes(user.role);
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

  const pages = CATALOG
    .filter((p) => eff.has(p.key))
    .map(({ key, label, path }) => ({ key, label, path }));

  if (isAdminish(user)) {
    pages.push({ key: 'admin', label: user.role === SYSADMIN ? 'Administration' : 'Settings', path: '/admin' });   // the same page, named for what the role can do there
  } else if (can(user, 'activity.view')) {
    pages.push({
      key: 'activity-history',
      label: 'Activity History',
      path: '/activity-history',
    });
  }

  pages.push({
    key: 'profile',
    label: 'Profile',
    path: '/profile',
    inNav: false,
  });

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
  ROLES, SYSADMIN, isSysAdmin, isAdminish, CATALOG, FIXED_PAGES, ROLE_ACTIONS, DEFAULT_ROLE_ACTIONS, ALL_ACTIONS, BUILTIN_ROLES, applyRoles, ACTION_PAGE, PAGE_BY_PATH,
  normalizeKeys, effectiveKeys, workloadTabs, canPage, canSection, can, allowedPages, allowedSections, allowedActions, landingPath,
};
