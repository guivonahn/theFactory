import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runTasks } from '../src/scheduler.js';
import { createWorkerManager, completedWorker, workerAcceptance, buildWorkerPrompt } from '../src/worker.js';

const mappingAcceptance = 'Identify project name, entrypoint, dependencies, and top-level modules with file:line references.';
const missingReadmeReport = '## Findings\npyproject.toml:2 - project name normid.\npyproject.toml:6 - dependencies textual and openpyxl.\npyproject.toml:14 - entrypoint normid.__main__:main.\nsrc/normid/app.py:96 - TUI app; ingest.py, detect.py, registry.py are core modules.\n## Open questions\nNone blocking.\n## Not finished\nREADME.md identification: file absent at repository root; only fixture-folder README exists. All other acceptance criteria met.\nTHEFACTORY_TASK_RESULT: incomplete';

function fixture(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'factory-engine-'));
  const calls = join(dir, 'calls.jsonl');
  const bin = join(dir, 'opencode');
  writeFileSync(join(dir, 'readme-report.txt'), missingReadmeReport);
  writeFileSync(bin, `#!/usr/bin/env node
const fs=require('node:fs');
const args=process.argv.slice(2), prompt=args.at(-1), id=prompt.match(/^Task:.*\\(([^()]+)\\)$/m)?.[1];
const emit=text=>console.log(JSON.stringify({type:'text',part:{text}}));
fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify({id,model:args[args.indexOf('-m')+1],handoff:prompt.includes('producer output')})+'\\n');
if(id==='partial') {emit('## Completed\\nImplemented part of the change.\\n## Not finished\\nCould not satisfy the acceptance check.\\nTHEFACTORY_TASK_RESULT: incomplete');}
else if(id==='map') {emit('## Findings\\nMapped modules and entry points.\\n## Not finished\\nTest suite not run (read-only mandate); graph-based path queries unavailable.');}
else if(id==='declared') {emit('## Findings\\nMapped modules.\\n## Not finished\\nNone.\\nTHEFACTORY_TASK_RESULT: completed');}
else if(id==='readme') {emit(fs.readFileSync(${JSON.stringify(join(dir, 'readme-report.txt'))},'utf8'));}
else if(id==='first') {emit('ready to cancel');setTimeout(()=>process.exit(0),5000);}
else if(id==='bad') setTimeout(()=>{console.error('fixture failed');process.exit(1)},20);
else setTimeout(()=>{emit(id==='good'?'producer output':'verified');process.exit(0)},50);
`, { mode: 0o700 });
  const manager = createWorkerManager({ continuationAttempts: 0, model: 'fixture/primary', fallbackModels: ['fixture/secondary'], autoFallback: false, ...options });
  const recorded = () => readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse);
  return { dir, bin, manager, recorded, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('real worker processes propagate failures, preserve primary models and pass dependency handoffs', async () => {
  const f = fixture();
  try {
    const result = await runTasks({
      tasks: [{ id: 'bad', agent: 'explorer' }, { id: 'good', agent: 'explorer' }, { id: 'blocked', agent: 'tester', deps: ['bad'] }, { id: 'consumer', agent: 'reviewer', deps: ['good'] }],
      executor: (task, { dependencies }) => f.manager.start({ task, bin: f.bin, dir: f.dir, artifacts: Object.values(dependencies).map((record) => record.output) }).done.then(completedWorker),
    });
    assert.equal(result.snapshot.find((task) => task.id === 'blocked').state, 'blocked');
    assert.equal(result.snapshot.find((task) => task.id === 'consumer').state, 'completed');
    const calls = f.recorded();
    assert.deepEqual(calls.map((call) => call.id).sort(), ['bad', 'consumer', 'good']);
    assert.ok(calls.every((call) => call.model === 'fixture/primary'));
    assert.equal(calls.find((call) => call.id === 'consumer').handoff, true);
  } finally { f.cleanup(); }
});

test('a worker reporting unfinished acceptance criteria does not complete its DAG task', async () => {
  const f = fixture();
  try {
    const result = await runTasks({
      tasks: [{ id: 'partial', agent: 'developer' }, { id: 'consumer', agent: 'reviewer', deps: ['partial'] }],
      executor: (task) => f.manager.start({ task, bin: f.bin, dir: f.dir }).done.then(completedWorker),
    });
    assert.equal(result.snapshot[0].state, 'blocked');
    assert.equal(result.snapshot[1].state, 'blocked');
    assert.match(f.manager.workers.values().next().value.error, /acceptance check/);
  } finally { f.cleanup(); }
});

test('aborting a running worker cancels the process and prevents queued work from launching', async () => {
  const f = fixture();
  const controller = new AbortController();
  try {
    f.manager.bus.onEvent((event) => {
      if (event.kind === 'status' && event.text.includes('ready to cancel')) {
        controller.abort();
        f.manager.cancel(event.workerId);
      }
    });
    const result = await runTasks({
      tasks: [{ id: 'first', agent: 'explorer' }, { id: 'queued', agent: 'reviewer' }],
      concurrency: 1, signal: controller.signal,
      executor: (task) => f.manager.start({ task, bin: f.bin, dir: f.dir }).done.then(completedWorker),
    });
    assert.ok(result.snapshot.every((task) => task.state === 'cancelled'));
    assert.deepEqual(f.recorded().map((call) => call.id), ['first']);
    assert.equal(f.manager.counts().cancelled, 1);
  } finally { f.cleanup(); }
});


test('mapping limitations do not block four dependent tasks (reported parallel regression)', async () => {
  const f = fixture();
  try {
    const result = await runTasks({
      tasks: [{ id: 'map', agent: 'explorer', acceptance: 'Inventory of modules and entry points' },
        { id: 'declared', agent: 'tester' },
        ...['quality', 'security', 'architecture', 'consolidate'].map((id) => ({ id, deps: ['map'] }))],
      executor: (task) => f.manager.start({ task, bin: f.bin, dir: f.dir }).done.then(completedWorker),
    });
    assert.ok(result.snapshot.every((task) => task.state === 'completed'));
    const record = [...f.manager.workers.values()].find((worker) => worker.taskId === 'map');
    assert.equal(record.acceptanceStatus, 'unreported');
    assert.match(record.limitations, /graph-based path queries unavailable/);
    assert.match(f.manager.list().find((worker) => worker.taskId === 'map').limitations, /Test suite not run/);
    assert.equal(f.recorded().length, 6);
    const declared = [...f.manager.workers.values()].find((worker) => worker.taskId === 'declared');
    assert.equal(declared.acceptanceStatus, 'completed');
    assert.equal(declared.limitations, '');
  } finally { f.cleanup(); }
});

test('acceptance status uses an explicit final declaration and ignores quoted examples', () => {
  assert.equal(workerAcceptance('## Not finished\nOptional graph tool unavailable.'), 'unreported');
  assert.equal(workerAcceptance('```\nTHEFACTORY_TASK_RESULT: incomplete\n```\nTHEFACTORY_TASK_RESULT: completed'), 'completed');
  assert.equal(workerAcceptance('THEFACTORY_TASK_RESULT: completed\nTHEFACTORY_TASK_RESULT: incomplete'), 'incomplete');
  const prompt = buildWorkerPrompt({ task: { id: 'map', title: 'Map modules', agent: 'explorer', readOnly: true } });
  assert.match(prompt, /optional tools/);
  assert.match(prompt, /THEFACTORY_TASK_RESULT: incomplete/);
});

test('missing README false failure is reviewed once and all five dependent tasks can finish', async () => {
  let reviews = 0;
  const f = fixture({ acceptanceLauncher: async (options) => {
    reviews++;
    assert.equal(options.agent, 'orchestrator');
    assert.equal(options.reportOnly, true);
    assert.match(options.task, /README.md identification/);
    options.onEvent({ text: JSON.stringify({ decision: 'completed', criterion: mappingAcceptance,
      reason: 'The source supplies the required map; the missing README is optional.',
      evidenceLines: [2, 3, 4, 5] }) });
    return { result: { code: 0 }, model: 'fixture/orca' };
  } });
  try {
    const result = await runTasks({ tasks: [
      { id: 'readme', title: 'Map repository structure and entrypoint', agent: 'explorer', acceptance: mappingAcceptance },
      ...['pipeline', 'tui', 'fixtures'].map((id) => ({ id, agent: 'explorer', deps: ['readme'] })),
      { id: 'tests', agent: 'tester', deps: ['pipeline', 'fixtures'] },
      { id: 'summary', agent: 'explorer', deps: ['pipeline', 'tui', 'fixtures', 'tests'] },
    ], executor: (task) => f.manager.start({ task, bin: f.bin, dir: f.dir }).done.then(completedWorker) });
    assert.ok(result.snapshot.every((task) => task.state === 'completed'));
    assert.equal(reviews, 1);
    assert.equal(f.recorded().length, 6);
    const record = f.manager.list().find((worker) => worker.taskId === 'readme');
    assert.equal(record.reportedAcceptanceStatus, 'incomplete');
    assert.equal(record.acceptanceStatus, 'completed');
    assert.equal(record.acceptanceReview.decision, 'completed');
    assert.match(record.limitations, /README.md/);
    assert.ok(f.manager.bus.list().some((event) => event.meta.acceptanceReview?.decision === 'completed'));
  } finally { f.cleanup(); }
});

test('rejected or unavailable acceptance reviews still block dependents', async () => {
  for (const decision of ['incomplete', 'unavailable']) {
    const f = fixture({ acceptanceLauncher: async (options) => {
      if (decision === 'unavailable') throw new Error('review provider unavailable');
      options.onEvent({ text: JSON.stringify({ decision, criterion: mappingAcceptance, reason: 'Required evidence is missing.', evidenceLines: [] }) });
      return { result: { code: 0 } };
    } });
    try {
      const result = await runTasks({ tasks: [{ id: 'readme', agent: 'explorer', acceptance: mappingAcceptance }, { id: 'consumer', agent: 'reviewer', deps: ['readme'] }],
        executor: (task) => f.manager.start({ task, bin: f.bin, dir: f.dir }).done.then(completedWorker) });
      assert.equal(result.snapshot[0].state, 'blocked');
      assert.equal(result.snapshot[1].state, 'blocked');
      assert.equal(f.manager.list()[0].acceptanceReview.decision, decision);
    } finally { f.cleanup(); }
  }
});

test('process failures and incomplete implementation or test tasks are never reviewed into success', async () => {
  let reviews = 0;
  const f = fixture({ acceptanceLauncher: async () => { reviews++; throw new Error('must not be called'); } });
  try {
    const result = await runTasks({ tasks: [
      { id: 'bad', agent: 'explorer', acceptance: mappingAcceptance },
      { id: 'partial', agent: 'developer', acceptance: 'Implement the entire change.' },
      { id: 'tests', agent: 'tester', deps: ['partial'] },
    ], executor: (task) => f.manager.start({ task, bin: f.bin, dir: f.dir }).done.then(completedWorker) });
    assert.equal(reviews, 0);
    assert.equal(result.snapshot[0].state, 'failed');
    assert.equal(result.snapshot[1].state, 'blocked');
    assert.equal(result.snapshot[2].state, 'blocked');
  } finally { f.cleanup(); }
});

test('abort during acceptance review cancels its handle and never launches a dependent', async () => {
  const controller = new AbortController(); let killed = false;
  const f = fixture({ acceptanceLauncher: (options) => new Promise((resolve) => {
    options.onHandle({ kill: () => { killed = true; resolve({ result: { code: 1, signal: 'SIGTERM' } }); } });
  }) });
  try {
    f.manager.bus.onEvent((event) => {
      if (event.kind === 'acceptance-review-started') { controller.abort(); f.manager.cancel(event.workerId); }
    });
    const result = await runTasks({ tasks: [{ id: 'readme', agent: 'explorer', acceptance: mappingAcceptance }, { id: 'consumer', agent: 'reviewer', deps: ['readme'] }],
      signal: controller.signal, executor: (task) => f.manager.start({ task, bin: f.bin, dir: f.dir }).done.then(completedWorker) });
    assert.equal(killed, true);
    assert.ok(result.snapshot.every((task) => task.state === 'cancelled'));
    assert.deepEqual(f.recorded().map((call) => call.id), ['readme']);
  } finally { f.cleanup(); }
});
