import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { App } from '../src/app.js';
import { makeMenuBarSnapshot, startMenuBarPublisher } from '../src/menuBar.js';

test('menu bar exports observed progress, separate workers and no logs or composer', () => {
  const app = new App({ mode: 'task' });
  app.startRun({ objective: 'Ship the native companion', parallel: { workers: 2 } });
  app.setParallelTasks([{ id: 'a', title: 'Data', state: 'completed' }, { id: 'b', title: 'UI', state: 'running' }]);
  app.setParallelWorkers([
    { workerId: 'w1', taskId: 'a', role: 'developer', state: 'completed', sessionId: 's1' },
    { workerId: 'w2', taskId: 'b', role: 'developer', state: 'running', sessionId: 's2' },
  ]);
  app.setInputValue('private draft that should not be exported');
  app.addLog('full logs should not be exported');
  const result = makeMenuBarSnapshot(app, { pid: 123, directory: '/Projects/test', now: 12345 });
  assert.equal(result.updatedAt, 12345);
  assert.equal(result.progress.fraction, 1 / 3);
  assert.deepEqual(result.agents.filter((a) => a.role === 'developer').map((a) => [a.id, a.state, a.detail]), [
    ['w1', 'completed', 'Data'], ['w2', 'working', 'UI'],
  ]);
  assert.equal(JSON.stringify(result).includes('should not be exported'), false);
});

test('unknown plan stays indeterminate and blocked run never implies completion', () => {
  const app = new App({ mode: 'task' });
  app.startRun({ objective: 'Work' });
  assert.equal(makeMenuBarSnapshot(app).progress.indeterminate, true);
  app.setParallelTasks([{ id: 'a', state: 'running' }]);
  app.setParallelWorkers([{ workerId: 'w', role: 'developer', taskId: 'a', state: 'running' }]);
  app.finishRun('blocked', 'Verification is unavailable');
  const result = makeMenuBarSnapshot(app);
  assert.equal(result.state, 'blocked');
  assert.equal(result.progress.fraction, 0);
  assert.equal(result.agents.find((a) => a.id === 'w').state, 'blocked');
});

test('distinct native child sessions are preserved and terminal controls are stripped', () => {
  const app = new App({ mode: 'task' });
  app.startRun({ objective: '\x1b[31mNative\x1b[0m\nworkers' });
  app.agentSessions.set('s1', { agent: 'developer', status: 'done' });
  app.agentSessions.set('s2', { agent: 'developer', status: 'working' });
  const result = makeMenuBarSnapshot(app);
  assert.equal(result.title, 'Native workers');
  assert.deepEqual(result.agents.filter((a) => a.role === 'developer').map((a) => [a.id, a.state]), [['s1', 'completed'], ['s2', 'working']]);
});

test('publisher writes private atomic heartbeats, refreshes and removes its own file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-menubar-'));
  const app = new App({ mode: 'task' });
  const file = path.join(dir, '123.json');
  const publisher = startMenuBarPublisher(app, { platform: 'darwin', stateDirectory: dir, pid: 123, interval: 20 });
  try {
    assert.equal(JSON.parse(fs.readFileSync(file)).schemaVersion, 1);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.existsSync(`${file}.tmp`), false);
    app.startRun({ objective: 'Updated objective' });
    await new Promise((resolve) => setTimeout(resolve, 65));
    assert.equal(JSON.parse(fs.readFileSync(file)).title, 'Updated objective');
    fs.writeFileSync(path.join(dir, 'other.json'), '{}');
    publisher.close();
    publisher.close();
    assert.equal(fs.existsSync(file), false);
    assert.equal(fs.existsSync(path.join(dir, 'other.json')), true);
  } finally { publisher.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('publisher failure is nonfatal and other platforms do not publish', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-menubar-'));
  try {
    const file = path.join(dir, 'not-a-directory');
    fs.writeFileSync(file, '');
    assert.doesNotThrow(() => startMenuBarPublisher(new App(), { platform: 'darwin', stateDirectory: file }).close());
    startMenuBarPublisher(new App(), { platform: 'linux', stateDirectory: dir }).close();
    assert.deepEqual(fs.readdirSync(dir), ['not-a-directory']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('live viewers project actual activity without claiming an unobserved percentage', () => {
  const app = new App({ mode: 'live' });
  app.applyEvent({ kind: 'status', from: 'developer', state: 'working', text: 'Writing code' });
  const result = makeMenuBarSnapshot(app);
  assert.equal(result.state, 'running');
  assert.equal(result.progress.indeterminate, true);
  assert.equal(result.progress.fraction, null);
});

test('unknown parallel roles still retain distinct workers in the other group', () => {
  const app = new App({ mode: 'task' });
  app.startRun({ parallel: { workers: 2 } });
  app.setParallelWorkers([
    { workerId: 'build-1', role: 'build', state: 'running' },
    { workerId: 'build-2', role: 'build', state: 'completed' },
  ]);
  assert.deepEqual(makeMenuBarSnapshot(app).agents.filter((a) => a.role === 'other').map((a) => a.id), ['build-1', 'build-2']);
});
