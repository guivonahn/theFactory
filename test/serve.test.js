import test from 'node:test';
import assert from 'node:assert/strict';
import { createServeClient } from '../src/serve.js';
import { App } from '../src/app.js';

test('createServeClient requires credentials and builds attributed requests', async () => {
  assert.throws(() => createServeClient({}), /baseUrl and password/);
  const calls = [];
  const origFetch = global.fetch;
  global.fetch = async (url, init) => {
    calls.push({ url, method: init?.method });
    const body = init?.body ? JSON.parse(init.body) : null;
    const json = url.endsWith('/permission')
      ? { data: [] }
      : url.includes('/permission/')
        ? { data: { id: 'per_1' } }
        : url.includes('/prompt')
          ? { data: { id: 'msg_1' } }
          : url.endsWith('/session') && init?.method === 'POST'
            ? { data: { id: 'ses_1' } }
            : { data: [] };
    return { ok: true, status: 200, text: async () => JSON.stringify(json) };
  };
  try {
    const client = createServeClient({ baseUrl: 'http://127.0.0.1:4999/', password: 'pw' });
    const sess = await client.createSession('t');
    assert.equal(sess.id, 'ses_1');
    await client.prompt('ses_1', 'hello');
    assert.deepEqual((await client.pendingPermissions('ses_1')).data, []);
    await client.replyPermission('ses_1', 'per_1', 'allow_once');
    assert.ok(calls.some((c) => c.url.includes('/reply')));
  } finally {
    global.fetch = origFetch;
  }
});

test('App parallel panel reflects real worker counts', () => {
  const app = new App({ width: 100, height: 32, color: false, mode: 'task', inputMode: true });
  app.startRun({ parallel: { workers: 3 } });
  const counts = app.setParallelWorkers([
    { workerId: 'w1', taskId: 'a', role: 'developer', sessionId: 'ses_a', state: 'running' },
    { workerId: 'w2', taskId: 'b', role: 'developer', sessionId: 'ses_b', state: 'completed' },
    { workerId: 'w3', taskId: 'c', role: 'tester', sessionId: null, state: 'queued' },
  ]);
  assert.equal(counts.running, 1);
  assert.equal(counts.completed, 1);
  assert.equal(counts.queued, 1);
  assert.match(app._runStatusLine(), /workers q1 r1/);
});
