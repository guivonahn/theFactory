import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchRunWithFallback, launchTaskWithRecovery } from '../src/run.js';
import { providerFailure } from '../src/recovery.js';
import { createWorkerManager, completedWorker } from '../src/worker.js';
import { runTasks } from '../src/scheduler.js';
import { App } from '../src/app.js';
import { logMatches } from '../src/logFormat.js';
import { synthesizeOverview, buildOverviewData } from '../src/completion.js';

function fixture(body) {
  const dir = mkdtempSync(join(tmpdir(), 'factory-recovery-'));
  const callsFile = join(dir, 'calls.jsonl');
  const bin = join(dir, 'opencode');
  writeFileSync(bin, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2), model = args[args.indexOf('-m') + 1], prompt = args.at(-1);
let prior = []; try { prior = fs.readFileSync(process.env.RECOVERY_CALLS, 'utf8').trim().split('\\n').filter(Boolean).map(JSON.parse); } catch {}
fs.appendFileSync(process.env.RECOVERY_CALLS, JSON.stringify({args, model, prompt}) + '\\n');
const text = value => console.log(JSON.stringify({type:'text', sessionID:'recovery-session', part:{text:value}}));
const error = value => console.log(JSON.stringify({type:'error', sessionID:'recovery-session', error: typeof value === 'string' ? {message:value} : value}));
${body}
`, { mode: 0o700 });
  return {
    dir, bin, env: { RECOVERY_CALLS: callsFile }, model: 'fixture/primary', fallbackModels: ['fixture/backup'], retryDelayMs: 0,
    calls: () => readFileSync(callsFile, 'utf8').trim().split('\n').map(JSON.parse),
    close: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test('provider classification covers structured failures and keeps permissions and system faults distinct', () => {
  for (const status of [408, 429, 500, 502, 503, 504]) assert.equal(providerFailure({ statusCode: status, message: 'request unsuccessful' }).retry, true);
  for (const message of ['insufficient_quota', 'usage_limit_exceeded', 'Your credit balance is too low', 'Monthly spending limit reached']) assert.equal(providerFailure(message).kind, 'quota');
  for (const message of ['401 invalid API key', '403 Forbidden']) assert.equal(providerFailure(message).kind, 'authentication');
  for (const message of ['Permission denied: shell', 'provider.use denied', 'Tool execution interrupted']) assert.equal(providerFailure(message).switchModel, false);
  for (const message of ['ENOENT', 'ENOSPC', 'Invalid configuration JSON']) assert.equal(providerFailure(message).kind, 'system');
});

test('temporary outages try other models, then recover on a later round with the same session', async () => {
  const f = fixture(`if (prior.length < 2) error({statusCode:503,message:'upstream service problem'}); else text('Recovered');`);
  try {
    const result = await launchRunWithFallback(f);
    assert.equal(result.result.code, 0);
    assert.deepEqual(f.calls().map((c) => c.model), ['fixture/primary', 'fixture/backup', 'fixture/primary']);
    assert.ok(f.calls().slice(1).every((c) => c.args[c.args.indexOf('--session') + 1] === 'recovery-session'));
    assert.equal(result.result.attempts.length, 2);
  } finally { f.close(); }
});

test('quota, auth, missing models and unknown provider errors fall through without false failure events', async () => {
  for (const message of ['You have reached your specified API usage limits.', '401 invalid API key', 'model not found', 'Unexpected upstream rejection']) {
    const f = fixture(`if (model === 'fixture/primary') error(${JSON.stringify(message)}); else text('Recovered');`);
    try {
      const events = [];
      const result = await launchRunWithFallback({ ...f, onEvent: (event) => events.push(event) });
      assert.equal(result.result.code, 0, message);
      assert.equal(f.calls().length, 2);
      assert.ok(events.filter((e) => e.type === 'error').every((e) => !e.error && e.providerError && e.logEntry.kind === 'status'));
    } finally { f.close(); }
  }
});

test('empty replies and stderr-only zero-exit provider failures recover instead of succeeding silently', async () => {
  for (const failure of ['', "console.error('usage limit exceeded');"]) {
    const f = fixture(`if (model === 'fixture/primary') { ${failure} } else text('Recovered');`);
    try {
      const result = await launchRunWithFallback(f);
      assert.equal(result.result.code, 0);
      assert.equal(result.model, 'fixture/backup');
    } finally { f.close(); }
  }
});

test('all unavailable routes produce a blocker with causes, while system faults remain failures', async () => {
  const f = fixture(`error('insufficient_quota');`);
  try {
    const result = await launchRunWithFallback(f);
    assert.equal(result.result.blocked, true);
    assert.equal(result.result.failureKind, 'quota');
    assert.equal(f.calls().length, 2, 'persistent quotas are never retried in extra rounds');
    assert.equal(result.result.attempts.length, 2);
    const missing = await launchRunWithFallback({ ...f, bin: join(f.dir, 'missing') });
    assert.equal(missing.result.failureKind, 'system');
    assert.equal(missing.result.blocked, false);
    assert.equal(missing.result.error.code, 'ENOENT');
  } finally { f.close(); }
});

test('temporary outages stop after bounded retry rounds and permission denial never changes routes', async () => {
  for (const [message, count] of [['503 service unavailable', 6], ['Permission denied: shell', 1]]) {
    const f = fixture(`error(${JSON.stringify(message)});`);
    try {
      const result = await launchRunWithFallback(f);
      assert.equal(result.result.blocked, true);
      assert.equal(f.calls().length, count);
    } finally { f.close(); }
  }
});

test('cancellation during backoff stops promptly without launching another attempt', async () => {
  const f = fixture(`error('503 service unavailable');`);
  try {
    const controller = new AbortController();
    const result = await launchRunWithFallback({ ...f, retryDelayMs: 5000, signal: controller.signal, onRetry: () => controller.abort() });
    assert.equal(result.result.cancelled, true);
    assert.equal(f.calls().length, 1);
  } finally { f.close(); }
});

test('a stuck error stream and a silent provider are terminated and recovered', async () => {
  for (const body of ["error('503 service unavailable'); setInterval(() => {}, 1000);", 'setInterval(() => {}, 1000);']) {
    const f = fixture(`if (model === 'fixture/primary') { ${body} } else text('Recovered');`);
    try {
      const result = await launchRunWithFallback({ ...f, errorGraceMs: 20, idleTimeoutMs: 500 });
      assert.equal(result.result.code, 0);
      assert.equal(result.model, 'fixture/backup');
      assert.equal(f.calls().length, 2);
    } finally { f.close(); }
  }
});

test('unfinished implementation continues in the same session and releases dependent tasks', async () => {
  const f = fixture(`if (!args.includes('--session')) text('## Not finished\\nFinish verification.\\nTHEFACTORY_TASK_RESULT: incomplete'); else text('Verified.\\nTHEFACTORY_TASK_RESULT: completed');`);
  try {
    const manager = createWorkerManager(f);
    const result = await runTasks({ tasks: [{ id: 'implement', agent: 'developer', readOnly: false }, { id: 'review', agent: 'reviewer', deps: ['implement'] }],
      executor: (task) => manager.start({ task, bin: f.bin, dir: f.dir }).done.then(completedWorker) });
    assert.ok(result.snapshot.every((t) => t.state === 'completed'));
    assert.equal(f.calls().length, 4);
    assert.match(f.calls()[1].prompt, /Do not repeat completed writes/);
    assert.equal(manager.bus.list({ kind: 'failed' }).length, 0);
    assert.equal(manager.bus.list({ kind: 'failure' }).length, 0);
  } finally { f.close(); }
});

test('genuinely unfinished work remains blocked with its output and never becomes a success', async () => {
  const f = fixture(`text('## Completed\\nSaved useful work.\\n## Not finished\\nExternal resource unavailable.\\nTHEFACTORY_TASK_RESULT: incomplete');`);
  try {
    const manager = createWorkerManager(f);
    const { record, done } = manager.start({ task: { id: 'implement', agent: 'developer', readOnly: false }, bin: f.bin, dir: f.dir });
    await done;
    assert.equal(f.calls().length, 3);
    assert.equal(record.state, 'blocked');
    assert.match(record.output, /Saved useful work/);
    assert.match(record.error, /External resource unavailable/);
    assert.throws(() => completedWorker(record), (error) => error.blocked === true);
    assert.equal(manager.counts().blocked, 1);
  } finally { f.close(); }
});

test('tool errors can recover without becoming task failures or triggering the error sound', async () => {
  const f = fixture(`console.log(JSON.stringify({type:'tool_use',part:{tool:'bash',state:{status:'error',error:'command failed'}}})); text('Used a working alternative.');`);
  try {
    const cues = [], app = new App({ onSound: (cue) => cues.push(cue) });
    const result = await launchTaskWithRecovery({ ...f, onEvent: (parsed) => { for (const event of parsed.events ?? []) app.applyEvent({ ...event, from: 'developer' }); } });
    assert.equal(result.result.code, 0);
    assert.equal(cues.includes('error'), false);
    app.startRun(); app.finishRun('blocked', 'All configured providers are unavailable');
    assert.equal(app.getPromptProgress().indeterminate, false);
    assert.match(app._runStatusLine(), /blocked/);
    assert.equal(cues.includes('error'), false);
  } finally { f.close(); }
});

test('summary retries discard stale text and retain the deterministic overview', async () => {
  const data = buildOverviewData({ objective: 'Test', state: 'done' });
  const result = await synthesizeOverview(data, { launcher: async (options) => {
    options.onEvent({ text: 'STALE RESPONSE' }); options.onRetry(); options.onEvent({ text: 'Recovered summary.' });
    return { result: { code: 0 } };
  } });
  assert.match(result.text, /Recovered summary/);
  assert.doesNotMatch(result.text, /STALE RESPONSE/);
});

test('run-local quota knowledge skips unavailable routes across workers and a new run probes again', async () => {
  const f = fixture(`if (model === 'fixture/primary') error('insufficient_quota'); else text('Completed');`);
  try {
    const manager = createWorkerManager(f);
    for (const id of ['one', 'two']) {
      const { done } = manager.start({ task: { id, agent: 'developer' }, bin: f.bin, dir: f.dir });
      assert.equal((await done).state, 'completed');
    }
    assert.deepEqual(f.calls().map((c) => c.model), ['fixture/primary', 'fixture/backup', 'fixture/backup']);
    const nextRun = createWorkerManager(f);
    await nextRun.start({ task: { id: 'three', agent: 'developer' }, bin: f.bin, dir: f.dir }).done;
    assert.deepEqual(f.calls().slice(-2).map((c) => c.model), ['fixture/primary', 'fixture/backup']);
  } finally { f.close(); }
});

test('all known exhausted routes return a blocker without spawning or pretending cancellation', async () => {
  const f = fixture(`error('insufficient_quota');`);
  try {
    const recoveryState = new Map();
    await launchRunWithFallback({ ...f, recoveryState });
    const result = await launchRunWithFallback({ ...f, recoveryState });
    assert.equal(f.calls().length, 2);
    assert.equal(result.result.blocked, true);
    assert.equal(Boolean(result.result.cancelled), false);
    assert.ok(result.result.attempts.every((attempt) => attempt.skipped));
  } finally { f.close(); }
});

test('partial output survives provider exhaustion and is included in the saved worker record', async () => {
  const f = fixture(`if (model === 'fixture/primary') { text('Implemented src/useful.js; verification remains.'); error('insufficient_quota'); } else error('insufficient_quota');`);
  try {
    const manager = createWorkerManager(f);
    const record = await manager.start({ task: { id: 'partial', agent: 'developer' }, bin: f.bin, dir: f.dir }).done;
    assert.equal(record.state, 'blocked');
    assert.match(record.output, /Implemented src\/useful.js/);
    assert.match(manager.list()[0].output, /Implemented src\/useful.js/);
    assert.equal(record.recoveryAttempts.length, 2);
  } finally { f.close(); }
});

test('tool permission denial without an answer blocks once, while a recovered answer completes', async () => {
  for (const recovered of [false, true]) {
    const f = fixture(`console.log(JSON.stringify({type:'tool_use',part:{tool:'bash',state:{status:'error',error:'Permission denied: shell'}}})); ${recovered ? "text('Answered using permitted source inspection.');" : ''}`);
    try {
      const result = await launchTaskWithRecovery(f);
      assert.equal(f.calls().length, 1);
      assert.equal(result.result.code, recovered ? 0 : 1);
      if (!recovered) assert.equal(result.result.failureKind, 'permission');
    } finally { f.close(); }
  }
  assert.equal(logMatches({ kind: 'status', status: 'recovering', text: 'Error: 429 quota exhausted' }, 'errors'), false);
  assert.equal(logMatches({ kind: 'error', text: 'ENOSPC' }, 'errors'), true);
});

test('cancelling after a partial report prevents continuation dispatch', async () => {
  const f = fixture(`text('THEFACTORY_TASK_RESULT: incomplete');`);
  try {
    let cancelled = false;
    const result = await launchTaskWithRecovery({ ...f, isCancelled: () => cancelled, assessResponse: () => { cancelled = true; return 'unfinished'; } });
    assert.equal(result.result.cancelled, true);
    assert.equal(f.calls().length, 1);
  } finally { f.close(); }
});
