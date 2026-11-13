import test from 'node:test';
import assert from 'node:assert/strict';
import { canReviewAcceptance, buildAcceptancePrompt, parseAcceptanceReview, reviewAcceptance } from '../src/acceptance.js';

const task = { id: 't1', title: 'Map repository structure and entrypoint', agent: 'explorer', readOnly: true, files: ['README.md', 'pyproject.toml'], acceptance: 'Identify project name, entrypoint, dependencies, and top-level modules with file:line references.' };
const report = 'pyproject.toml:2 - project name normid. pyproject.toml:6 - dependencies textual, openpyxl. pyproject.toml:14 - entrypoint normid.__main__:main. src/normid/app.py:96 - TUI app; ingest.py, detect.py, registry.py are core modules.\n## Not finished\nREADME.md absent at repository root. All other acceptance criteria met.\nTHEFACTORY_TASK_RESULT: incomplete';
const reviewed = { decision: 'completed', criterion: task.acceptance, reason: 'The requested map is supplied; an optional missing README is a finding.', evidenceLines: [1] };

test('only disputed read-only investigations are eligible for acceptance review', () => {
  assert.equal(canReviewAcceptance(task), true);
  for (const changed of [{ readOnly: false }, { agent: 'developer' }, { agent: 'tester' }, { acceptance: '' }]) assert.equal(canReviewAcceptance({ ...task, ...changed }), false);
  const prompt = buildAcceptancePrompt({ objective: 'how does this project work?', task, report });
  assert.match(prompt, /search hint/);
  assert.match(prompt, /Do not invent requirements/);
  assert.match(prompt, /README/);
  assert.ok(prompt.includes(task.acceptance));
});

test('a completed review requires the exact criterion and supporting numbered lines in the report', () => {
  const result = parseAcceptanceReview(JSON.stringify(reviewed), { task, report });
  assert.equal(result.decision, 'completed');
  assert.equal(result.evidence[0], report.split('\n')[0]);
  for (const invalid of [
    { evidenceLines: [] }, { evidenceLines: [999] }, { evidenceLines: [1, 1] }, { evidenceLines: ['1'] },
    { criterion: 'Create a root README.' }, { decision: 'success' }, { reason: '' },
  ]) assert.throws(() => parseAcceptanceReview(JSON.stringify({ ...reviewed, ...invalid }), { task, report }));
});

test('acceptance review is a single text-only orchestrator request with preserved routing', async () => {
  let calls = 0;
  const value = await reviewAcceptance({ task, report, model: 'fixture/selected', agentModels: { orchestrator: 'fixture/orca' }, launcher: async (options) => {
    calls++;
    assert.equal(options.reportOnly, true);
    assert.equal(options.agent, 'orchestrator');
    assert.equal(options.model, 'fixture/selected');
    assert.equal(options.agentModels.orchestrator, 'fixture/orca');
    options.onEvent({ text: JSON.stringify(reviewed), logEntry: { id: 'review' } });
    return { result: { code: 0 }, model: 'fixture/orca' };
  } });
  assert.equal(calls, 1);
  assert.equal(value.decision, 'completed');
  assert.equal(value.model, 'fixture/orca');
});

test('unavailable, invalid or negative reviews never approve unfinished work', async () => {
  for (const launcher of [
    async () => { throw new Error('provider unavailable'); },
    async () => ({ result: { code: 1 } }),
    async (options) => { options.onEvent({ text: 'not JSON' }); return { result: { code: 0 } }; },
    async (options) => { options.onEvent({ text: JSON.stringify({ ...reviewed, evidenceLines: [] }) }); return { result: { code: 0 } }; },
  ]) assert.equal((await reviewAcceptance({ task, report, launcher })).decision, 'unavailable');
  const negative = await reviewAcceptance({ task, report, launcher: async (options) => {
    options.onEvent({ text: JSON.stringify({ ...reviewed, decision: 'incomplete', reason: 'Requested evidence missing.', evidenceLines: [] }) });
    return { result: { code: 0 } };
  } });
  assert.equal(negative.decision, 'incomplete');
});

test('cancellation prevents review dispatch or kills a review launched during cancellation', async () => {
  const cancelled = await reviewAcceptance({ task, report, isCancelled: () => true, launcher: () => assert.fail('must not launch') });
  assert.equal(cancelled.decision, 'unavailable');
  let stopped = false, killed = false;
  const value = await reviewAcceptance({ task, report, isCancelled: () => stopped, launcher: async (options) => {
    stopped = true; options.onHandle({ kill: (signal) => { killed = signal === 'SIGTERM'; } });
    options.onEvent({ text: JSON.stringify(reviewed) });
    return { result: { code: 0 } };
  } });
  assert.equal(killed, true);
  assert.equal(value.decision, 'unavailable');
});

test('review retries discard earlier partial responses', async () => {
  const value = await reviewAcceptance({ task, report, launcher: async (options) => {
    options.onEvent({ text: 'stale incomplete JSON', logEntry: { id: 'earlier' } });
    options.onRetry();
    options.onEvent({ text: JSON.stringify(reviewed), logEntry: { id: 'later' } });
    return { result: { code: 0 } };
  } });
  assert.equal(value.decision, 'completed');
});

test('review timeout kills its process and retains the original incomplete result', async () => {
  const keepAlive = setInterval(() => {}, 1000);
  try {
    const value = await reviewAcceptance({ task, report, timeoutMs: 10, launcher: (options) => new Promise((resolve) => {
      options.onHandle({ kill: () => resolve({ result: { code: 1, signal: 'SIGTERM' } }) });
    }) });
    assert.equal(value.decision, 'unavailable');
    assert.match(value.reason, /timed out/);
  } finally { clearInterval(keepAlive); }
});

test('provider errors in JSON retain their cause even with empty stderr', async () => {
  const value = await reviewAcceptance({ task, report, launcher: async (options) => {
    options.onEvent({ error: 'Model unavailable: fixture/removed' });
    return { result: { code: 1, stderr: '' } };
  } });
  assert.equal(value.decision, 'unavailable');
  assert.match(value.reason, /Model unavailable/);
});
