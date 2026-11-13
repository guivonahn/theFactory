import test from 'node:test';
import assert from 'node:assert/strict';
import { App } from '../src/app.js';
import { Canvas, displayWidth } from '../src/canvas.js';

const contains = (area, cell) => cell.row >= area.row && cell.row < area.row + area.height && cell.col >= area.col && cell.col < area.col + area.width;

test('both data lanes stay continuous and visible around every worker at every representative size', () => {
  for (const width of [60, 61, 80, 100, 140, 220]) for (const height of [24, 25, 32, 40, 65]) {
    for (const inputMode of [false, true]) {
      const app = new App({ width, height, inputMode, color: false, reducedMotion: true });
      app.showOther = true;
      const slots = [...app.layout.agents, app.layout.other];
      const workers = [app.layout.centerWorker, ...slots.map((slot) => slot.worker)];
      for (const slot of slots) for (const path of [slot.path, slot.returnPath]) {
        for (let index = 0; index < path.length; index++) {
          const cell = path[index];
          assert.ok(cell.row >= 0 && cell.row < app.layout.statusRow && cell.col >= 0 && cell.col < width);
          assert.ok(workers.every((area) => !contains(area, cell)), `${width}x${height}: tracks avoid creatures`);
          if (index > 0) assert.equal(Math.abs(cell.row - path[index - 1].row) + Math.abs(cell.col - path[index - 1].col), 1);
        }
      }
      app.draw();
      const buffer = app.canvas._buffers[app.canvas._back];
      const boxes = [app.layout.center, ...slots.map((slot) => slot.box)];
      for (const cell of app._otherTracks) {
        if (boxes.some((box) => contains(box, cell))) continue;
        assert.match(buffer.chars[cell.row][cell.col], /^[─│╭╮╰╯├┤┬┴┼]$/u, `${width}x${height}: no erased track segments`);
      }
    }
  }
});

test('composer displays the actual caret, preserves spacing and follows earlier pasted lines', () => {
  const app = new App({ width: 60, height: 24, inputMode: true, color: false });
  app.setInputValue('  abcd', 4);
  assert.match(app.snapshot(), /task>   ab▌d/);
  app.setInputValue('alpha\nbeta\ngamma', 1);
  assert.match(app.snapshot(), /\[pasted 3 lines\] a▌pha/);
  app.setInputValue('A界B', 2);
  assert.match(app.snapshot(), /A界▌/);
  app.setInputValue('x'.repeat(200), 3);
  const rows = app.snapshot().split('\n');
  assert.match(rows[app.layout.inputRows[0]], /xxx▌x/);
  for (const row of rows) assert.ok(displayWidth(row) <= 60);
});

test('agent feed shows the newest messages and idle names retain their identity colors', () => {
  const app = new App({ width: 100, height: 45, color: false });
  for (let index = 0; index < 12; index++) app.applyEvent({ kind: 'msg', from: 'developer', dir: 'in', text: `message-${index}` });
  app.setAgentStatus('developer', 'idle');
  const text = app.snapshot();
  assert.match(text, /message-11/);
  assert.doesNotMatch(text, /message-0\b/);
  const slot = app._slots.get('developer');
  const buffer = app.canvas._buffers[app.canvas._back];
  const labelStart = buffer.chars[slot.box.row].join('').indexOf('DEVELOPER');
  assert.equal(buffer.styles[slot.box.row][labelStart], app.agents.get('developer').def.color);
});

test('footer reserves size text and keeps essential controls visible in small terminals', () => {
  const app = new App({ width: 60, height: 24, color: false, inputMode: true });
  app.startRun({ pid: 1234, sessionID: 's'.repeat(200) });
  const row = app.snapshot().split('\n')[app.layout.statusRow];
  assert.match(row, /Esc abort.*\/log logs\s+60×24$/);
  app.setSession('s'.repeat(200), 'long title');
  app.resize(60, 40);
  assert.ok(app.snapshot().split('\n').every((line) => displayWidth(line) <= 60));
});

test('failure text cannot be mistaken for completion and explicit working status remains working', () => {
  const app = new App({ color: false });
  app.applyEvent({ kind: 'status', from: 'tester', state: 'idle', text: 'failed: incomplete result' });
  assert.equal(app.agents.get('tester').workerState, 'failed');
  assert.equal(app.agents.get('tester').status, 'idle');
  app.openLog('tester');
  assert.match(app.snapshot(), /LATEST · failed/);
  app.closeLog();
  app.applyEvent({ kind: 'status', from: 'tester', state: 'working', text: 'finishing the run' });
  assert.equal(app.agents.get('tester').status, 'working');
});

test('wide characters never leak continuation sentinels into terminal output or snapshots', () => {
  const canvas = new Canvas(10, 2, { color: false });
  canvas.write(0, 0, 'A界B');
  assert.equal(canvas.toPlainText(), 'A界B\n');
  assert.doesNotMatch(canvas.flush(), /\u0000/);
  canvas.clear();
  canvas.write(0, 0, 'A界C');
  assert.match(canvas.flush(), /C/);
});

test('resizing preserves a running task and retargets packets onto the current tracks', () => {
  const app = new App({ width: 100, height: 40, color: false });
  app.startRun({ pid: 1234 });
  app.applyEvent({ kind: 'msg', dir: 'out', to: 'developer', text: 'keep working' });
  app.applyEvent({ kind: 'msg', dir: 'in', from: 'explorer', text: 'some files' });
  app.advance(100);
  const progress = app.packets[0].progress / (app.packets[0].path.length - 1);
  assert.equal(app.resize(40, 15), false);
  assert.match(app.snapshot(), /Terminal too small.*\nResize to 60×24.*\nTask continues/);
  assert.equal(app.run.state, 'running');
  assert.equal(app.run.pid, 1234);
  assert.equal(app.resize(80, 32), true);
  assert.equal(app.packets[0].progress / (app.packets[0].path.length - 1), progress);
  for (const packet of app.packets) {
    const slot = app._slots.get(packet.agentKey);
    assert.deepEqual(packet.path, packet.dir === 'in' ? [...slot.returnPath].reverse() : slot.path);
  }
  assert.match(app.snapshot(), /DEVELOPER/);
});

test('elapsed time works from clock zero and active auxiliary agents use the correct denominator', () => {
  const app = new App({ width: 100, height: 40, color: false });
  app.startRun();
  app.advance(1500);
  app.finishRun('done');
  assert.equal(app.runElapsedSeconds(), 1);
  app.applyEvent({ kind: 'tool', from: 'auxiliary', text: 'build' });
  assert.match(app.snapshot(), /1\/7 working/);
});
