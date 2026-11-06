import test from 'node:test';
import assert from 'node:assert/strict';
import { App } from '../src/app.js';
import { AGENT_ORDER } from '../src/agents.js';

function makeApp() {
  return new App({ width: 100, height: 32, color: false, mode: 'demo' });
}

test('App accumulates full per-agent history beyond the 2-line feed', () => {
  const app = makeApp();
  for (let i = 0; i < 5; i += 1) {
    app.applyEvent({ kind: 'msg', from: 'developer', dir: 'in', text: `note ${i}` });
  }
  app.applyEvent({ kind: 'tool', from: 'developer', text: 'edit auth.js' });
  app.applyEvent({ kind: 'status', from: 'developer', text: 'done' });

  const state = app.agents.get('developer');
  assert.equal(state.messages.length, 5, 'pillar feed keeps the last messages');
  assert.ok(state.history.length >= 7, `history keeps everything, got ${state.history.length}`);
  assert.ok(state.history.some((entry) => entry.text === 'note 0'));
  assert.ok(state.history.some((entry) => entry.kind === 'tool' && entry.text === 'edit auth.js'));
});

test('App log viewer opens, cycles, scrolls and renders an overlay', () => {
  const app = makeApp();
  app.applyEvent({ kind: 'msg', from: 'explorer', dir: 'in', text: 'found 3 files' });
  app.applyEvent({ kind: 'msg', from: 'developer', dir: 'in', text: 'patched the lock' });

  app.openLog('developer');
  assert.equal(app.logView.open, true);
  assert.equal(app.logView.agentKey, 'developer');
  let snap = app.snapshot();
  assert.match(snap, /LOG: DEVELOPER/);
  assert.match(snap, /patched the lock/);

  // Cycle forward/back through orchestrator + pillars + other.
  const order = ['orchestrator', ...AGENT_ORDER, 'other'];
  const before = app.logView.agentKey;
  app.cycleLogAgent(1);
  assert.notEqual(app.logView.agentKey, before);
  assert.ok(order.includes(app.logView.agentKey));
  app.cycleLogAgent(-1);
  assert.equal(app.logView.agentKey, before);

  // Scroll semantics: scrollLog(-1) moves back, scrollLog(+1) moves forward.
  for (let i = 0; i < 10; i += 1) {
    app.applyEvent({ kind: 'msg', from: 'developer', dir: 'in', text: `line ${i}` });
  }
  app.openLog('developer');
  assert.equal(app.logView.scroll, 0);
  app.scrollLog(-1);
  assert.ok(app.logView.scroll > 0);
  app.scrollLog(1);
  app.scrollLog(99);
  assert.ok(app.logView.scroll >= 0);

  app.closeLog();
  assert.equal(app.logView.open, false);
  snap = app.snapshot();
  assert.doesNotMatch(snap, /LOG: DEVELOPER/);
});

test('App log wraps long entries into visual rows and clamps scroll over them', () => {
  const app = makeApp();
  const text = Array.from({ length: 36 }, (_, index) => `word${index}`).join(' ');
  app.applyEvent({ kind: 'msg', from: 'developer', dir: 'in', text });
  app.openLog('developer');

  const wrapped = app._logLines(20);
  assert.ok(wrapped.length > 1, 'long entry occupies multiple visual rows');
  assert.ok(wrapped[0].startsWith('« '), 'entry marker stays on the first row');
  assert.ok(wrapped.slice(1).every((line) => !line.startsWith('« ')));
  assert.ok(wrapped.at(-1).includes('word35'));

  const snapshot = app.snapshot().split('\n');
  const header = snapshot.findIndex((line) => line.includes('LOG: DEVELOPER'));
  assert.match(snapshot[header + 1], /1 entries/);
  const body = snapshot.slice(header + 2, header + 20);
  assert.ok(body.every((line) => !line.includes('…')));
  assert.match(body.join('\n'), /word35/);

  const allRows = app._logLines(100);
  app.scrollLog(-100);
  assert.deepEqual(app._logLines(2), allRows.slice(0, 2));
  assert.equal(app.logView.scroll, allRows.length - 2);
});

test('App input wraps across two rows and keeps short input on one row', () => {
  const app = new App({ width: 100, height: 32, color: false, mode: 'task', inputMode: true });
  const value = Array.from({ length: 18 }, (_, index) => `token${index}`).join(' ');
  app.setInputValue(value);
  assert.deepEqual(app.layout.inputRows, [30, 31]);

  let rows = app.snapshot().split('\n');
  assert.match(rows[30], /task> .*token0/);
  assert.match(rows[31], /token17▌/);
  assert.ok(!rows[30].includes('…') && !rows[31].includes('…'));

  app.setInputValue('short task');
  rows = app.snapshot().split('\n');
  assert.match(rows[30], /task> short task▌/);
  assert.equal(rows[31], '');
});

test('App run status reports new vs continued with the session id', () => {
  const app = makeApp();
  app.startRun({ sessionID: null, resumed: false });
  assert.match(app._runStatusLine(), /new/);
  app.startRun({ sessionID: 'ses_abcdef1234567890', resumed: true });
  assert.match(app._runStatusLine(), /continued/);
  assert.match(app._runStatusLine(), /session ses_abcdef1234/);
});
