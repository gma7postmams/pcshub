const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const live = require('../src/live');

// the bus is internal; listen the way the stream route does, by calling publish() and reading what comes out of a fake response
function listen() {
  const got = [];
  const router = live;
  const layer = router.stack.find((l) => l.route && l.route.path === '/stream');
  const handler = layer.route.stack[0].handle;
  const req = new EventEmitter(); req.user = { id: 1, role: 'System Admin' };
  const res = { status() { return this; }, set() { return this; }, flushHeaders() {}, write(s) { const m = /^data: (.*)$/m.exec(s); if (m) got.push(JSON.parse(m[1])); } };
  handler(req, res);
  return { got: () => got.filter((m) => m.t !== 'ping'), close: () => req.emit('close') };
}

test('a workload change also tells the plug list, and the other way round', () => {
  const l = listen();
  live.publish('workload', 'tab1');
  live.publish('plugs', null);
  const topics = l.got().map((m) => m.t);
  assert.deepStrictEqual(topics.sort(), ['plugs', 'plugs', 'workload', 'workload']);
  assert.ok(l.got().some((m) => m.by === 'tab1'));
  l.close();
});

test('unknown topics are ignored', () => {
  const l = listen();
  live.publish('nonsense');
  assert.strictEqual(l.got().length, 0);
  l.close();
});

test('track() only announces successful writes', () => {
  const l = listen();
  const run = (method, status) => {
    const res = new EventEmitter(); res.statusCode = status;
    live.track('ingest')({ method, get: () => 't9' }, res, () => {});
    res.emit('finish');
  };
  run('GET', 200); run('POST', 400); run('PUT', 500);
  assert.strictEqual(l.got().length, 0);
  run('POST', 201); run('DELETE', 200);
  assert.strictEqual(l.got().length, 2);
  l.close();
});
