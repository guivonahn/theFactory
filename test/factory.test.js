import test from 'node:test';
import assert from 'node:assert/strict';
import { App } from '../src/app.js';
import { drawFactory, isFactoryBusy, factoryGeometry, smokePuffs } from '../src/factory.js';
import { displayWidth } from '../src/canvas.js';
import { AGENT_ORDER } from '../src/agents.js';

test('factory art and logo stay inside the reserved sky at narrow and roomy sizes', () => {
  for (const width of [60, 61, 80, 100, 140, 220]) for (let height = 24; height <= 65; height++) {
    const app = new App({ width, height, inputMode: true, reducedMotion: false, color: false });
    app.startRun(); app.advance(900);
    const put = app.canvas.put.bind(app.canvas);
    app.canvas.put = (row, col, glyph, style) => {
      assert.ok(row >= 0 && row < app.layout.sky.rows, `${width}x${height}: art stays above workers`);
      assert.ok(col >= 0 && col < width);
      put(row, col, glyph, style);
    };
    drawFactory(app);
    assert.doesNotMatch(app.canvas.toPlainText(), /[ᴗωᵔ•]/u, 'the factory has no face');
  }
});

test('factory animates from actual agent activity, rests, and respects reduced motion', () => {
  const app = new App({ width: 100, height: 42, reducedMotion: false, color: false });
  app.setAgentStatus('developer', 'working');
  assert.equal(isFactoryBusy(app), true);
  const sky = () => { app.canvas.clear(); drawFactory(app); return app.canvas.toPlainText(); };
  const first = sky(); app.advance(500);
  assert.notEqual(sky(), first);
  app.setAgentStatus('developer', 'idle'); app.advance(2000);
  const resting = sky(); app.advance(1000);
  assert.equal(sky(), resting);
  app.reducedMotion = true; app.startRun();
  const reduced = sky(); app.advance(1000);
  assert.equal(sky(), reduced);
});

test('factory preview shows parallel role counts and full worker totals remain truthful', () => {
  const app = new App({ width: 140, height: 42, factoryPreview: true, reducedMotion: true, color: false });
  const text = app.snapshot();
  assert.match(text, /Factory preview/);
  assert.match(text, /DEVELOPER ×2/);
  assert.match(text, /3\/4 run q1 ✓2/);
  app.setParallelWorkers(Array.from({ length: 15 }, (_, index) => ({ workerId: `w${index}`, role: 'developer', state: index === 0 ? 'completed' : 'running' })));
  assert.equal(app.parallel.counts.running, 14);
  assert.equal(app.agents.get('developer').status, 'working', 'one completion cannot hide other workers');
  app.resize(60, 24);
  assert.ok(app.snapshot().split('\n').every((line) => displayWidth(line) <= 60));
  const panelApp = new App({ width: 140, height: 42, color: false });
  for (const agent of AGENT_ORDER) panelApp.setAgentStatus(agent, 'working');
  const rows = panelApp.snapshot().split('\n');
  assert.ok(rows[panelApp.layout.sky.rows - 1].startsWith('└'), 'the full active-agent panel stays above worker footprints');
});

test('session labels cannot erase the visible chimney plume, including reduced motion', () => {
  for (const [width, height] of [[80, 32], [100, 40], [140, 42]]) for (const reducedMotion of [false, true]) {
    const app = new App({ width, height, inputMode: true, color: false, reducedMotion });
    app.startRun(); app.setSession('ses_fixture_header', 'A long session title that must avoid the chimney');
    app.draw();
    const geometry = factoryGeometry(app);
    const puffs = smokePuffs(geometry, { now: app.now, busy: true, reducedMotion });
    assert.ok(puffs.length > 0);
    const buffer = app.canvas._buffers[app.canvas._back];
    for (const puff of puffs) for (const [index, glyph] of [...puff.text].entries()) {
      assert.equal(buffer.chars[puff.row][puff.col + index], glyph, `${width}x${height}: smoke survives header rendering`);
    }
  }
});
