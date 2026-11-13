import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLayout } from '../src/layout.js';
import { drawFactory, isFactoryBusy } from '../workin_on/factory.js';
import { App } from '../src/app.js';

/** Iterate a few representative sizes without touching UI elements. */
function spotApp(width, height) {
  return new App({ width, height, color: false, inputMode: true, reducedMotion: false });
}

test('sky region is reserved and the top agent band shifts down by it', () => {
  for (const h of [24, 26, 28, 30, 34, 42]) {
    const layout = buildLayout(90, h, { footerRows: 1 });
    const skyRows = layout.sky.rows;
    const topBox = layout.agents.find((slot) => slot.band === 'top').box;
    assert.equal(topBox.row, skyRows + 1, 'top band sits below the sky slice');
    assert.ok(skyRows + 1 + 4 < layout.center.row, 'top band clears the center box');
  }
  // Graceful scale: 3 sky rows at 24-high terminals, up to 7 at the cap.
  assert.equal(buildLayout(90, 24, { footerRows: 1 }).sky.rows, 3);
  assert.equal(buildLayout(90, 28, { footerRows: 1 }).sky.rows, 5);
  assert.equal(buildLayout(90, 32, { footerRows: 1 }).sky.rows, 7);
  assert.equal(buildLayout(90, 42, { footerRows: 1 }).sky.rows, 7);
});

test('factory is busy only while a run, workers, or packets are active', () => {
  const app = spotApp(90, 42);
  assert.equal(isFactoryBusy(app), false);

  app.startRun({});
  assert.equal(isFactoryBusy(app), true);

  const parallelApp = spotApp(90, 28);
  parallelApp.setParallelEnabled(true);
  parallelApp.setParallelWorkers([{ workerId: 'w1', state: 'running' }]);
  assert.equal(isFactoryBusy(parallelApp), true);

  const queuedApp = spotApp(90, 28);
  queuedApp.setParallelWorkers([]);
  queuedApp.parallel.counts = { queued: 2, running: 0 };
  assert.equal(isFactoryBusy(queuedApp), true);

  const packetApp = spotApp(90, 28);
  packetApp.applyEvent({ kind: 'msg', dir: 'out', to: 'explorer', text: 'hi' });
  assert.equal(isFactoryBusy(packetApp), true);
});

test('smoke appears while busy and drains after the cooldown, never before', () => {
  const app = spotApp(90, 42);
  app.applyEvent({ kind: 'msg', dir: 'out', to: 'developer', text: 'work' });

  const skyText = () =>
    app.snapshot().split('\n').slice(0, 2).join('\\n').trim();
  assert.ok(skyText().length > 0, 'smoke visible while packets run');
  const whileBusy = skyText();

  app.advance(5000); // past COOLDOWN_MS = 1600 and out of packet lifetimes
  app.run.state = 'idle';
  app.setAgentStatus('developer', 'idle');
  app.parallel.counts = { queued: 0, running: 0 };
  assert.equal(isFactoryBusy(app), false);
  assert.notEqual(skyText(), whileBusy, 'smoke leaves the sky after cooldown');
  // Only the static silhouette may remain above the agent band.
  const resting = app.snapshot().split('\n').slice(0, 2).join('\n');
  assert.ok(!/[○◌°]/u.test(resting), 'no smoke glyphs at rest: ' + JSON.stringify(resting));
});

test('the silhouette and sign stay inside the sky slice at every spot size', () => {
  for (const [w, h] of [[60, 24], [66, 26], [90, 28], [110, 34], [140, 50]]) {
    const app = spotApp(w, h);
    app.applyEvent({ kind: 'msg', dir: 'out', to: 'developer', text: 'busy' });
    app.advance(900);
    const rows = app.snapshot().split('\n');
    const skyRows = app.layout.sky.rows;
    const sky = rows.slice(0, skyRows);
    if (skyRows < 3) {
      if (skyRows > 0) assert.ok(sky.some((line) => line.includes('theFactory')), 'short header keeps the compact brand');
      continue;
    }
    assert.ok(sky.some((line) => line.includes('┌──┐')), `${w}x${h}: industrial factory roof`);
    assert.ok(sky.some((line) => line.includes('the')), `${w}x${h}: wordmark`);
    assert.ok(sky.some((line) => line.includes('█▀▀')), `${w}x${h}: compact pixel lettering`);
    for (let row = skyRows; row < rows.length; row += 1) {
      const line = rows[row];
      assert.ok(
        !line.includes('█▀▀') && !line.includes('┌──┐'),
        `${w}x${h}: nothing painted below the sky (row ${row}): ${JSON.stringify(line)}`,
      );
    }
  }
});

test('drawFactory never crashes with colour cycled on/off', () => {
  for (const color of [true, false]) {
    const app = new App({ width: 80, height: 28, color, inputMode: true });
    app.applyEvent({ kind: 'tool', from: 'orchestrator', text: 'ping', fanout: true });
    app.advance(200);
    app.frame();
  }
});
