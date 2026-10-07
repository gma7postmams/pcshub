const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../src/permissions');

const user = (role, perms = ['ingest', 'workload', 'plugs', 'knowledge']) => ({ role, perms });

test.beforeEach(() => {
  // back to the built-in defaults before each test
  P.applyRoles(Object.entries(P.DEFAULT_ROLE_ACTIONS).map(([name, actions]) => ({ name, actions })));
});

test('Admin holds every action and every page', () => {
  for (const a of P.ALL_ACTIONS) assert.ok(P.can({ role: 'Admin', perms: [] }, a), a);
  assert.ok(P.canPage({ role: 'Admin', perms: [] }, '/admin'));
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
  assert.deepEqual(P.ROLES, ['Admin', 'Manager', 'QA']);
  assert.deepEqual(P.ROLE_ACTIONS.QA, ['workload.write']);
  assert.ok(P.can(user('QA'), 'workload.write'));
  assert.equal(P.can(user('QA'), 'ingest.write'), false);
  assert.deepEqual(P.ROLE_ACTIONS.Admin, P.ALL_ACTIONS);
  assert.equal(P.can(user('Ingest'), 'ingest.cm_complete'), false);   // a role that no longer exists has no actions
});

test('prototype-ish names are not roles or actions', () => {
  assert.equal(P.can(user('__proto__'), 'ingest.write'), false);
  assert.equal(P.can(user('Editor'), 'constructor'), false);
});
