// COOKIE_SECURE=auto: the HTTPS address (through the proxy) gets the secure side, the plain-HTTP LAN address the ordinary side.
const test = require('node:test');
const assert = require('node:assert');

const load = (env) => {
  for (const k of ['COOKIE_SECURE', 'NODE_ENV']) delete process.env[k];
  Object.assign(process.env, env);
  delete require.cache[require.resolve('../src/config')];
  return require('../src/config');
};

test('auto: decided per request, names differ so the two never clash', () => {
  const c = load({ NODE_ENV: 'production', COOKIE_SECURE: 'auto' });
  assert.strictEqual(c.cookieAuto, true);
  assert.strictEqual(c.isSecureReq({ secure: true }), true);
  assert.strictEqual(c.isSecureReq({ secure: false }), false);
  assert.strictEqual(c.isSecureReq(undefined), false);
  assert.strictEqual(c.cookieNameFor(true), '__Host-phub.sid');
  assert.strictEqual(c.cookieNameFor(false), 'phub.sid');
});

test('production without auto stays all-HTTPS, COOKIE_SECURE=false all-plain', () => {
  let c = load({ NODE_ENV: 'production' });
  assert.strictEqual(c.isSecureReq({ secure: false }), true);
  c = load({ NODE_ENV: 'production', COOKIE_SECURE: 'false' });
  assert.strictEqual(c.isSecureReq({ secure: true }), false);
  c = load({ NODE_ENV: 'development' });
  assert.strictEqual(c.isSecureReq({ secure: true }), false);
});
