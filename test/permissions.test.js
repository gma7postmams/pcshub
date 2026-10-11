const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../src/permissions');

const user = (role, perms = ['ingest', 'workload', 'plugs', 'knowledge']) => ({ role, perms });

test.beforeEach(() => {
  // back to the built-in defaults before each test
  P.applyRoles(Object.entries(P.DEFAULT_ROLE_ACTIONS).map(([name, actions]) => ({ name, actions })));
});

test('System Admin holds every action and every page', () => {
  for (const a of P.ALL_ACTIONS) assert.ok(P.can({ role: 'System Admin', perms: [] }, a), a);
  assert.ok(P.canPage({ role: 'System Admin', perms: [] }, '/admin'));
});

test('Admin holds every action except the Admin-area one, and every page', () => {
  const admin = { role: 'Admin', perms: [] };
  for (const a of P.ALL_ACTIONS.filter((x) => x !== 'admin')) assert.ok(P.can(admin, a), a);
  assert.equal(P.can(admin, 'admin'), false);
  assert.ok(P.canPage(admin, '/admin'));                 // the page opens; the server limits it to Audit Log and Dropdowns
  assert.ok(P.canPage(admin, '/ingest'));
});

test('Ingest role can only set CM status', () => {
  const u = user('Ingest');
  assert.deepEqual(P.allowedActions(u), ['ingest.cm_complete']);
  assert.equal(P.can(u, 'ingest.write'), false);
  assert.equal(P.can(u, 'ingest.approve'), false);
  assert.equal(P.can(u, 'ingest.delete'), false);
});

test('Editor creates/edits ingest; Viewer does nothing; Manager approves', () => {
  assert.ok(P.can(user('Editor'), 'ingest.write'));
  assert.equal(P.can(user('Editor'), 'ingest.approve'), false);
  assert.deepEqual(P.allowedActions(user('Viewer')), []);
  assert.ok(P.can(user('Manager'), 'ingest.approve'));
  assert.equal(P.can(user('Manager'), 'ingest.delete'), false);
});

test('an action also needs the page: no Ingest page in the group, no ingest actions', () => {
  assert.equal(P.can(user('Manager', ['workload']), 'ingest.write'), false);
  assert.ok(P.can(user('Manager', ['workload']), 'workload.write'));
});

test('only Admin can open /admin, whatever the group', () => {
  assert.equal(P.canPage(user('Manager'), '/admin'), false);
});

test('a section is dropped when its page is not granted', () => {
  assert.deepEqual(P.normalizeKeys(['dashboard.kpis']), []);
  assert.deepEqual(P.normalizeKeys(['dashboard', 'dashboard.kpis', 'nonsense']).sort(), ['dashboard', 'dashboard.kpis']);
});

test('applyRoles: custom role, in-place update, Admin always full, unknown actions dropped', () => {
  const rolesRef = P.ROLES; const actionsRef = P.ROLE_ACTIONS;
  P.applyRoles([{ name: 'Manager', actions: ['ingest.write'] }, { name: 'QA', actions: ['workload.write', 'bogus.action'] }]);
  assert.strictEqual(P.ROLES, rolesRef);            // the same array / object other modules already hold
  assert.strictEqual(P.ROLE_ACTIONS, actionsRef);
  assert.deepEqual(P.ROLES, ['System Admin', 'Admin', 'Manager', 'QA']);
  assert.deepEqual(P.ROLE_ACTIONS.QA, ['workload.write']);
  assert.ok(P.can(user('QA'), 'workload.write'));
  assert.equal(P.can(user('QA'), 'ingest.write'), false);
  assert.deepEqual(P.ROLE_ACTIONS['System Admin'], P.ALL_ACTIONS);
  assert.deepEqual(P.ROLE_ACTIONS.Admin, P.ALL_ACTIONS.filter((a) => a !== 'admin'));
  assert.equal(P.can(user('Ingest'), 'ingest.cm_complete'), false);   // a role that no longer exists has no actions
});

test('prototype-ish names are not roles or actions', () => {
  assert.equal(P.can(user('__proto__'), 'ingest.write'), false);
  assert.equal(P.can(user('Editor'), 'constructor'), false);
});
