import test from 'node:test';
import assert from 'node:assert/strict';
import { App } from '../src/app.js';

function makeApp() {
  return new App({ width: 140, height: 40, color: false, mode: 'task', inputMode: true });
}

test('finishRun done clears ACTIVE AGENTS panel', () => {
  const app = makeApp();
  app.startRun({});
  app.applyEvent({ kind: 'msg', from: 'developer', dir: 'in', text: 'patched the file' });
  app.applyEvent({ kind: 'tool', from: 'tester', text: 'run pytest' });
  assert.equal(app.agents.get('developer').status, 'working');
  assert.equal(app.agents.get('tester').status, 'working');
  assert.match(app.snapshot(), /ACTIVE AGENTS \([1-9]/);

  app.finishRun('done', 'all good');

  assert.equal(app.agents.get('developer').status, 'done');
  assert.equal(app.agents.get('tester').status, 'done');
  assert.match(app.snapshot(), /ACTIVE AGENTS \(0\)/);
  assert.match(app.snapshot(), /none working/);
});

test('finishRun error/aborted settles working agents to idle, not working', () => {
  const app = makeApp();
  app.startRun({});
  app.applyEvent({ kind: 'msg', from: 'reviewer', dir: 'in', text: 'checking diff' });
  app.finishRun('error', 'boom');
  assert.equal(app.agents.get('reviewer').status, 'idle');
  assert.match(app.snapshot(), /ACTIVE AGENTS \(0\)/);

  const app2 = makeApp();
  app2.startRun({});
  app2.applyEvent({ kind: 'msg', from: 'security', dir: 'in', text: 'auditing' });
  app2.finishRun('aborted');
  assert.equal(app2.agents.get('security').status, 'idle');
  assert.match(app2.snapshot(), /ACTIVE AGENTS \(0\)/);
});

test('parallel completion pattern settles agent to done', () => {
  const app = makeApp();
  app.applyEvent({ kind: 'msg', dir: 'out', to: 'developer', text: 'do the task' });
  assert.equal(app.agents.get('developer').status, 'working');
  // main.js completed handler: msg-in (flips to working) then explicit settle.
  app.applyEvent({ kind: 'msg', dir: 'in', from: 'developer', text: 'finished output' });
  app.applyEvent({ kind: 'status', from: 'developer', text: 'done', state: 'done' });
  assert.equal(app.agents.get('developer').status, 'done');
  assert.match(app.snapshot(), /ACTIVE AGENTS \(0\)/);
});

test('failure status settles to idle instead of stuck working', () => {
  const app = makeApp();
  app.applyEvent({ kind: 'tool', from: 'tester', text: 'pytest' });
  assert.equal(app.agents.get('tester').status, 'working');
  app.applyEvent({ kind: 'status', from: 'tester', text: '✗ failed: timeout', state: 'idle' });
  assert.equal(app.agents.get('tester').status, 'idle');
  app.applyEvent({ kind: 'tool', from: 'explorer', text: 'grep' });
  app.applyEvent({ kind: 'status', from: 'explorer', text: '✗ oops' });
  assert.equal(app.agents.get('explorer').status, 'idle');
});
