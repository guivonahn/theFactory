import test from 'node:test';
import assert from 'node:assert/strict';
import { createEventBus } from '../src/events.js';
import { buildWorkerPrompt } from '../src/worker.js';
import { overlappingFiles, baseMismatch } from '../src/workspaces.js';
import { detectConflicts, integrate } from '../src/integrate.js';
import { backoffMs, isTransientError, reconcile, resumePlan } from '../src/parallelState.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('event bus dedupes and attributes', () => {
  const bus = createEventBus();
  const seen = [];
  bus.onEvent((e) => seen.push(e.kind));
  bus.publish({ id: 'e1', runId: 'r1', workerId: 'w1', taskId: 't1', sessionId: 's1', kind: 'started', text: 'hi' });
  bus.publish({ id: 'e1', kind: 'started', text: 'dup' });
  assert.equal(bus.list().length, 1);
  assert.equal(bus.list({ workerId: 'w1' })[0].sessionId, 's1');
  assert.deepEqual(seen, ['started']);
});

test('buildWorkerPrompt scopes per-task context without whole history', () => {
  const p = buildWorkerPrompt({ objective: 'Ship', task: { id: 't1', title: 'Do x', acceptance: 'tests pass', files: ['src/a.js'] }, artifacts: ['out/1'] });
  assert.match(p, /Objective: Ship/);
  assert.match(p, /Acceptance: tests pass/);
  assert.match(p, /Scope: src\/a\.js/);
});

test('overlappingFiles detects write conflicts', () => {
  const overlaps = overlappingFiles([
    { taskId: 'a', files: ['src/x.js', 'src/y.js'] },
    { taskId: 'b', files: ['src/x.js'] },
  ]);
  assert.equal(overlaps.length, 1);
  assert.equal(overlaps[0].file, 'src/x.js');
  assert.equal(baseMismatch({ baseRev: 'r1' }, 'r2'), true);
  assert.equal(baseMismatch({ baseRev: 'r1' }, 'r1'), false);
});

test('integrate blocks conflicts and never copies them', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-int-'));
  const wa = path.join(tmp, 'wa'); const wb = path.join(tmp, 'wb'); const out = path.join(tmp, 'out');
  fs.mkdirSync(wa, { recursive: true }); fs.mkdirSync(wb, { recursive: true });
  fs.writeFileSync(path.join(wa, 'x.js'), 'version-a');
  fs.writeFileSync(path.join(wb, 'x.js'), 'version-b');
  fs.writeFileSync(path.join(wa, 'only-a.js'), 'a');
  const res = integrate({ manifests: [{ taskId: 'a', dir: wa, files: ['x.js', 'only-a.js'] }, { taskId: 'b', dir: wb, files: ['x.js'] }], integrationDir: out });
  assert.equal(res.clean, false);
  assert.equal(res.blocked.length, 1);
  assert.ok(fs.existsSync(path.join(out, 'only-a.js')));
  assert.ok(!fs.existsSync(path.join(out, 'x.js')));
  assert.deepEqual(detectConflicts([{ taskId: 'a', files: ['f'] }]).clean, true);
});

test('backoff is bounded and transient detection works; reconcile does not complete interrupted', () => {
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    assert.ok(backoffMs({ attempt, rand: () => 0 }) <= 5000);
  }
  assert.equal(isTransientError('quota 429'), true);
  assert.equal(isTransientError('permission denied'), false);
  const { reconciled, interrupted } = reconcile({ workers: [{ workerId: 'w1', state: 'running' }, { workerId: 'w2', state: 'completed' }], tasks: [], events: [] }, new Set());
  assert.deepEqual(interrupted, ['w1']);
  assert.equal(reconciled[0].state, 'interrupted');
  assert.equal(reconciled[1].state, 'completed');
});

test('resumePlan only auto-resumes read-only/idempotent work', () => {
  const saved = {
    workers: [{ workerId: 'w1', state: 'running' }],
    tasks: [
      { id: 'read1', state: 'interrupted', readOnly: true },
      { id: 'write1', state: 'pending', readOnly: false },
      { id: 'done1', state: 'completed', readOnly: true },
      { id: 'idem1', state: 'ready', readOnly: false, idempotent: true },
    ],
    events: [],
  };
  const plan = resumePlan(saved, new Set());
  assert.deepEqual(plan.resumable.map((r) => r.taskId).sort(), ['idem1', 'read1']);
  assert.deepEqual(plan.needsReview.map((r) => r.taskId), ['write1']);
  assert.deepEqual(plan.interrupted, ['w1']);
});
