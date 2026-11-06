import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { apiRequest, formAnswerBody } from '../src/opencodeApi.js';

function stubSpawn({ stdout = '', stderr = '', code = 0, error = null, throws = null } = {}) {
  const calls = [];
  const spawnFn = (bin, args, options) => {
    calls.push({ bin, args, options });
    if (throws) throw throws;
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdout.setEncoding = () => {};
    child.stderr.setEncoding = () => {};
    child.kill = () => {};
    queueMicrotask(() => {
      if (error) {
        child.emit('error', error);
        return;
      }
      if (stdout) child.stdout.emit('data', stdout);
      if (stderr) child.stderr.emit('data', stderr);
      child.emit('close', code);
    });
    return child;
  };
  return { spawnFn, calls };
}

test('apiRequest returns parsed JSON and forwards the method, path, and body', async () => {
  const { spawnFn, calls } = stubSpawn({ stdout: '{"ok":true,"items":[1]}' });
  const result = await apiRequest('post', '/api/session/ses_1/form', { answer: { a: 1 } }, {
    bin: 'oc',
    spawnFn,
  });
  assert.deepEqual(result, {
    ok: true,
    data: { ok: true, items: [1] },
    raw: '{"ok":true,"items":[1]}',
    error: null,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].bin, 'oc');
  assert.deepEqual(calls[0].args, [
    'api',
    'post',
    '/api/session/ses_1/form',
    '--data',
    '{"answer":{"a":1}}',
  ]);
});

test('apiRequest treats empty stdout as a null success payload', async () => {
  const { spawnFn } = stubSpawn({ code: 0 });
  const result = await apiRequest('delete', '/api/x', null, { spawnFn });
  assert.equal(result.ok, true);
  assert.equal(result.data, null);
  assert.equal(result.raw, '');
  assert.equal(result.error, null);
});

test('apiRequest surfaces non-zero exits with concise stderr', async () => {
  const { spawnFn } = stubSpawn({ code: 2, stderr: '  not   found \n' });
  const result = await apiRequest('get', '/api/x', undefined, { spawnFn });
  assert.equal(result.ok, false);
  assert.equal(result.data, null);
  assert.equal(result.error, 'not found');
});

test('apiRequest rejects invalid JSON without throwing', async () => {
  const { spawnFn } = stubSpawn({ stdout: '{' });
  const result = await apiRequest('get', '/api/x', undefined, { spawnFn });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'opencode api returned invalid JSON');
  assert.equal(result.raw, '{');
});

test('apiRequest reports ENOENT and synchronous spawn failures', async () => {
  const missing = Object.assign(new Error('spawn oc ENOENT'), { code: 'ENOENT' });
  const { spawnFn } = stubSpawn({ error: missing });
  const result = await apiRequest('get', '/api/x', undefined, { bin: 'oc', spawnFn });
  assert.equal(result.ok, false);
  assert.match(result.error, /opencode binary not found: oc/);

  const thrown = await apiRequest('get', '/api/x', undefined, {
    spawnFn: () => { throw new Error('nope'); },
  });
  assert.equal(thrown.ok, false);
  assert.equal(thrown.error, 'nope');
});

test('apiRequest times out instead of hanging the poller', async () => {
  let killed = false;
  const spawnFn = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdout.setEncoding = () => {};
    child.stderr.setEncoding = () => {};
    child.kill = () => { killed = true; };
    return child;
  };
  const result = await apiRequest('get', '/api/x', undefined, { spawnFn, timeout: 10 });
  assert.equal(result.ok, false);
  assert.match(result.error, /timed out after 10ms/);
  assert.equal(killed, true);
});

test('formAnswerBody wraps the answer map', () => {
  assert.deepEqual(formAnswerBody({ name: 'alice' }), { answer: { name: 'alice' } });
  assert.deepEqual(formAnswerBody({}), { answer: {} });
});
