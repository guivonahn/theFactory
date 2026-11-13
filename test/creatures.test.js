import test from 'node:test';
import assert from 'node:assert/strict';
import { App } from '../src/app.js';
import { AGENT_ORDER, AGENTS, ORCHESTRATOR } from '../src/agents.js';
import { Canvas, charWidth, displayWidth } from '../src/canvas.js';
import { buildLayout } from '../src/layout.js';
import { parseArgs } from '../src/main.js';
import { WORKER_DESIGNS, WORKER_STATES, WORKER_WIDTH, workerSprite, workerFrame, prefersReducedMotion, drawWorker } from '../src/creatures.js';

test('all creature designs, roles, states and poses fit their cell footprints', () => {
  for (const design of WORKER_DESIGNS) for (const state of WORKER_STATES) {
    for (const key of ['orchestrator', ...AGENT_ORDER, 'other']) for (const height of [5, 6]) for (const width of [WORKER_WIDTH, 22]) {
      for (let frame = 0; frame < 6; frame++) {
        const rows = workerSprite({ design, state, key, frame, height, width });
        assert.equal(rows.length, height);
        for (const row of rows) {
          assert.equal(displayWidth(row), width, `${design}/${key}/${state}/${frame}`);
          for (const glyph of row) assert.equal(charWidth(glyph), 1, 'only single-cell glyphs');
        }
      }
    }
  }
});

test('workers animate independently, celebration settles, and reduced motion is still expressive', () => {
  const phases = AGENT_ORDER.map((key) => workerFrame({ key, state: 'working', elapsed: 150 }));
  assert.ok(new Set(phases).size > 1);
  assert.equal(workerFrame({ state: 'completed', elapsed: 10000 }), 5);
  assert.equal(workerFrame({ state: 'completed', elapsed: 300 }), 2);
  for (const state of WORKER_STATES) {
    assert.equal(workerFrame({ state, elapsed: 10000, reducedMotion: true }), 0);
    const frames = Array.from({ length: 6 }, (_, frame) => workerSprite({ state, frame }).join('\n'));
    assert.ok(new Set(frames).size >= 4, `${state} has at least four distinct poses`);
  }
  assert.equal(prefersReducedMotion({ FACTORY_REDUCED_MOTION: '1' }), true);
  assert.equal(prefersReducedMotion({ REDUCE_MOTION: '1' }), true);
  assert.equal(prefersReducedMotion({ TERM: 'dumb' }), true);
  assert.equal(prefersReducedMotion({}), false);
});

const overlaps = (a, b) => a.col < b.col + b.width && b.col < a.col + a.width && a.row < b.row + b.height && b.row < a.row + a.height;

test('all workers, names and controls fit across terminal sizes, including auxiliary agents', () => {
  for (const width of [60, 61, 80, 100, 140, 220]) for (let height = 24; height <= 65; height++) {
    for (const footerRows of [1, 3]) {
      const layout = buildLayout(width, height, { footerRows, workers: true });
      const areas = [layout.center, layout.centerWorker, ...[...layout.agents, layout.other].flatMap((slot) => [slot.box, slot.worker])];
      for (const area of areas) {
        assert.ok(area.row >= 0 && area.col >= 0);
        assert.ok(area.col + area.width <= width);
        assert.ok(area.row + area.height <= layout.statusRow, `${width}x${height}: keeps footer clear`);
      }
      for (let i = 0; i < areas.length; i++) for (let j = i + 1; j < areas.length; j++) {
        assert.ok(!overlaps(areas[i], areas[j]), `${width}x${height}: reserved areas never overlap`);
      }
    }
  }
});

test('real events drive thinking, tools, completion and failure without changing active-agent semantics', () => {
  const app = new App({ width: 100, height: 40, color: false, reducedMotion: false });
  const state = app.agents.get('developer');
  app.applyEvent({ kind: 'msg', dir: 'out', to: 'developer', text: 'implement the thing' });
  assert.equal(state.workerState, 'thinking');
  app.advance(200);
  app.applyEvent({ kind: 'tool', from: 'developer', text: 'edit' });
  assert.equal(state.workerState, 'working');
  const since = state.workerSince;
  app.advance(50);
  app.applyEvent({ kind: 'tool', from: 'developer', text: 'edit again' });
  assert.equal(state.workerSince, since, 'streaming updates do not restart animations');
  app.applyEvent({ kind: 'status', from: 'developer', state: 'done', text: 'complete' });
  assert.equal(state.workerState, 'completed');
  app.applyEvent({ kind: 'status', from: 'developer', state: 'idle', text: '✗ failed' });
  assert.equal(state.workerState, 'failed');
  assert.equal(state.status, 'idle');
  app.applyEvent({ kind: 'tool', from: 'developer', text: 'retry' });
  assert.equal(state.workerState, 'working');
  app.finishRun('error', 'timeout');
  assert.equal(state.workerState, 'failed');
  assert.equal(app.orchestratorWorker.workerState, 'failed');
  assert.equal(state.status, 'idle');
});

test('worker diff flushes are small, stable, monochrome-safe and do not clear the terminal', () => {
  const canvas = new Canvas(30, 10, { color: false });
  const area = { row: 1, col: 3, width: WORKER_WIDTH, height: 6 };
  const paint = (elapsed) => { canvas.clear(); drawWorker(canvas, area, { key: 'developer', state: 'working', elapsed }); return canvas.flush(); };
  paint(0);
  assert.equal(paint(0), '');
  const diff = paint(300);
  assert.ok(diff.length > 0 && diff.length < 300);
  assert.doesNotMatch(diff, /\x1b\[[0-9;]*[mJ]/);
});

test('preview and default TUI retain agent names, resize, logs, input and reduced-motion stability', () => {
  assert.equal(parseArgs(['--worker-preview', '--reduced-motion']).workerPreview, true);
  assert.equal(parseArgs(['--reduced-motion']).reducedMotion, true);
  for (const [width, height] of [[60, 24], [100, 32], [140, 42]]) {
    const app = new App({ width, height, color: false, inputMode: true, workerPreview: true, reducedMotion: true });
    let text = app.snapshot();
    for (const key of AGENT_ORDER) assert.ok(text.includes(key.toUpperCase()));
    for (const def of [ORCHESTRATOR, ...AGENTS]) assert.ok(text.includes(def.name), `${width}x${height}: ${def.name} stays visible`);
    assert.match(text, /ORCHESTRATOR/);
    assert.match(text, /task>/);
    assert.match(text, /dumpling/);
    assert.match(text, /bean/);
    assert.match(text, /puff/);
    app.advance(2000);
    assert.equal(app.snapshot(), text, 'reduced-motion audition stays still');
    const slot = app.layout.agents[0];
    assert.equal(app.hitAgentMsg(slot.worker.col + 2, slot.worker.row + 2), 'explorer');
    app.openLog('explorer');
    assert.match(app.snapshot(), /LOG: EXPLORER/);
    app.closeLog();
    app.resize(60, 24);
    text = app.snapshot();
    assert.equal(text.split('\n').length, 24);
    for (const line of text.split('\n')) assert.ok(displayWidth(line) <= 60);
  }
});

test('large props remain recognizable and contained beside the crew in compact and roomy slots', () => {
  for (const width of [16, 22, 40]) for (const height of [5, 6]) for (const key of AGENT_ORDER) for (const state of WORKER_STATES) {
    const canvas = new Canvas(width + 4, height + 4, { color: false });
    drawWorker(canvas, { row: 2, col: 2, width, height }, { key, state, elapsed: 300 });
    const text = canvas.toPlainText().split('\n');
    assert.ok(text[0].trim() === '' && text[1].trim() === '' && text.at(-1).trim() === '');
    for (const row of text) assert.ok(row.slice(0, 2).trim() === '' && row.slice(width + 2).trim() === '', `${key}/${state} stays in its slot`);
  }
  const keyboard = workerSprite({ key: 'developer', width: 22 }).join('\n');
  const wall = workerSprite({ key: 'security', width: 22 }).join('\n');
  const building = workerSprite({ key: 'architect', width: 22 }).join('\n');
  assert.match(keyboard, /\[___\]/);
  assert.match(wall, /├┬┴┬┴┬┤/);
  assert.match(building, /▪ ▪ ▪/);
  assert.match(building, /▯/);
});
