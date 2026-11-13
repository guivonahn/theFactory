import test from 'node:test';
import assert from 'node:assert/strict';
import { validateTasks, createScheduler, runTasks, scopesConflict } from '../src/scheduler.js';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

test('validateTasks rejects duplicate ids, missing deps, cycles', () => {
  assert.throws(() => validateTasks([{ id: 'a' }, { id: 'a' }]), /duplicate/);
  assert.throws(() => validateTasks([{ id: 'a', deps: ['missing'] }]), /missing dependency/);
  assert.throws(
    () => validateTasks([{ id: 'a', deps: ['b'] }, { id: 'b', deps: ['a'] }]),
    /cycle/,
  );
  assert.throws(() => validateTasks([{ id: 'a', deps: ['a'] }]), /itself|cycle/);
  const ok = validateTasks([{ id: 'a' }, { id: 'b', deps: ['a'] }]);
  assert.equal(ok.length, 2);
  assert.equal(ok[1].readOnly, true);
});

test('scope locks serialize conflicting readers/writers without starving independent work', () => {
  const scheduler = createScheduler({ maxConcurrency: 3 }).submit([
    { id: 'write', readOnly: false, files: ['src/shared.js'] },
    { id: 'read', readOnly: true, files: ['./src/shared.js'] },
    { id: 'other', readOnly: false, files: ['src/other.js'] },
  ]);
  assert.equal(scheduler.dispatchNext().id, 'write');
  assert.equal(scheduler.dispatchNext().id, 'other');
  assert.equal(scheduler.dispatchNext(), null);
  scheduler.markComplete('write');
  assert.equal(scheduler.dispatchNext().id, 'read');
  assert.equal(scopesConflict({ readOnly: true, files: [] }, { readOnly: true, files: [] }), false);
  assert.equal(scopesConflict({ readOnly: false, files: ['src'] }, { readOnly: true, files: ['src/a.js'] }), true);
  assert.equal(scopesConflict({ readOnly: false, files: ['src\\a.js'] }, { readOnly: true, files: ['src/./a.js'] }), true);
  assert.equal(scopesConflict({ readOnly: false, files: [] }, { readOnly: true, files: ['README.md'] }), true);
  assert.equal(validateTasks([{ id: 'writer', agent: 'developer' }])[0].readOnly, false);
});

test('synchronous failures settle and block dependents while unrelated tasks finish', async () => {
  const launched = [];
  const result = await runTasks({
    tasks: [{ id: 'bad' }, { id: 'good' }, { id: 'consumer', deps: ['bad'] }],
    executor: (task) => { launched.push(task.id); if (task.id === 'bad') throw new Error('boom'); return 'ok'; },
  });
  assert.deepEqual(launched.sort(), ['bad', 'good']);
  assert.equal(result.snapshot.find((task) => task.id === 'consumer').state, 'blocked');
  assert.equal(result.results.good, 'ok');
});

test('dependency outputs reach consumers and retries do not duplicate completed work', async () => {
  let attempts = 0;
  const result = await runTasks({
    tasks: [{ id: 'source' }, { id: 'consumer', deps: ['source'] }], maxRetries: 1,
    executor: (task, { dependencies }) => {
      if (task.id === 'source') { if (++attempts === 1) throw new Error('retry'); return { output: 'verified paths' }; }
      assert.equal(dependencies.source.output, 'verified paths');
      return 'accepted';
    },
  });
  assert.equal(result.results.consumer, 'accepted');
  assert.equal(attempts, 2);
});

test('abort stops queued dispatch and preserves cancelled task states', async () => {
  const controller = new AbortController();
  const launched = [];
  const result = await runTasks({
    tasks: [{ id: 'first' }, { id: 'queued' }, { id: 'dependent', deps: ['first'] }],
    concurrency: 1, signal: controller.signal,
    executor: (task) => { launched.push(task.id); controller.abort(); return 'interrupted'; },
  });
  assert.deepEqual(launched, ['first']);
  assert.ok(result.snapshot.every((task) => task.state === 'cancelled'));
});

test('scheduler releases ready tasks without waiting for unrelated branches', () => {
  const s = createScheduler({ maxConcurrency: 3 });
  s.submit([
    { id: 'a' },
    { id: 'b' },
    { id: 'c', deps: ['a'] },
    { id: 'd', deps: ['b'] },
  ]);
  assert.deepEqual(s.readyTasks().map((t) => t.id).sort(), ['a', 'b']);
  const a = s.dispatchNext();
  assert.equal(a.id, 'a');
  s.markComplete('a', 'done-a');
  // c becomes ready immediately even though b still pending/running.
  assert.ok(s.readyTasks().some((t) => t.id === 'c'));
});

test('scheduler enforces concurrency limit and no duplicate dispatch', () => {
  const s = createScheduler({ maxConcurrency: 2 });
  s.submit([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
  assert.equal(s.dispatchNext().id, 'a');
  assert.equal(s.dispatchNext().id, 'b');
  assert.equal(s.dispatchNext(), null); // limit reached
  s.markComplete('a', 1);
  const c = s.dispatchNext();
  assert.equal(c.id, 'c');
});

test('scheduler propagates failure as blocked and caps retries', () => {
  const s = createScheduler({ maxRetries: 0 });
  s.submit([{ id: 'a' }, { id: 'b', deps: ['a'] }]);
  s.dispatchNext(); // a
  s.markFailed('a', new Error('boom'));
  assert.equal(s.snapshot().find((t) => t.id === 'b').state, 'blocked');
});

test('runTasks proves overlapping wall-clock execution and dependency order', async () => {
  const tasks = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd', deps: ['a', 'b', 'c'] }];
  const intervals = [];
  const start = Date.now();
  const { results, snapshot } = await runTasks({
    tasks,
    concurrency: 3,
    executor: async (task) => {
      const t0 = Date.now() - start;
      await delay(80);
      const t1 = Date.now() - start;
      intervals.push({ id: task.id, t0, t1 });
      return `${task.id}-done`;
    },
  });
  for (const id of ['a', 'b', 'c', 'd']) assert.equal(results[id], `${id}-done`);
  assert.equal(snapshot.find((t) => t.id === 'd').state, 'completed');
  // Independent a/b/c overlap: earliest start < latest end minus ~single duration.
  const abc = intervals.filter((i) => ['a', 'b', 'c'].includes(i.id));
  const minStart = Math.min(...abc.map((i) => i.t0));
  const maxEnd = Math.max(...abc.map((i) => i.t1));
  assert.ok(maxEnd - minStart < 240, `overlap: span ${maxEnd - minStart}ms (sequential >=240)`);
  // d starts only after a/b/c finish.
  const d = intervals.find((i) => i.id === 'd');
  for (const i of abc) assert.ok(d.t0 >= i.t1, `d started ${d.t0} before ${i.id} ended ${i.t1}`);
});
