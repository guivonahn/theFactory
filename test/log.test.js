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
  assert.equal(state.messages.length, 2, 'pillar feed still shows the last 2');
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

test('App run status reports new vs continued with the session id', () => {
  const app = makeApp();
  app.startRun({ sessionID: null, resumed: false });
  assert.match(app._runStatusLine(), /new/);
  app.startRun({ sessionID: 'ses_abcdef1234567890', resumed: true });
  assert.match(app._runStatusLine(), /continued/);
  assert.match(app._runStatusLine(), /session ses_abcdef1234/);
});
