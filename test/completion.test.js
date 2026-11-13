import test from 'node:test';
import assert from 'node:assert/strict';
import { App } from '../src/app.js';
import { promptProgress, progressBar } from '../src/progress.js';
import { buildOverviewData, buildOverviewPrompt, renderOverview, synthesizeOverview, unfinishedRecap } from '../src/completion.js';
import { parseRunLine } from '../src/run.js';
import { agentPromptsRunEnv } from '../src/agentPrompts.js';
import { displayWidth } from '../src/canvas.js';

function outcomes() {
  return buildOverviewData({ objective: 'Ship the feature', state: 'error', tasks: [
    { id: 'build', title: 'Implement the feature', agent: 'developer', state: 'completed' },
    { id: 'tests', title: 'Run regression tests', agent: 'tester', state: 'failed' },
    { id: 'review', title: 'Review the integrated change', agent: 'reviewer', state: 'blocked', deps: ['tests'] },
    { id: 'docs', title: 'Update docs', agent: 'developer', state: 'cancelled' },
  ], workers: [
    { taskId: 'build', output: 'Implemented src/feature.js', state: 'completed' },
    { taskId: 'tests', output: 'npm test: 1 failure', error: 'regression failed', state: 'failed' },
  ] });
}

test('progress counts completed steps, reserves the recap, and cannot claim partial runs are complete', () => {
  const tasks = [{ state: 'completed' }, { state: 'running' }, { state: 'pending' }];
  assert.equal(promptProgress({ tasks, runState: 'running' }).fraction, 0.25);
  const completed = tasks.map(() => ({ state: 'completed' }));
  const recapping = promptProgress({ tasks: completed, runState: 'running', phase: 'recap' });
  assert.equal(recapping.fraction, 0.75);
  assert.match(recapping.label, /recap/);
  assert.equal(promptProgress({ tasks: completed, runState: 'done', overviewReady: true }).fraction, 1);
  for (const runState of ['error', 'aborted']) {
    const partial = promptProgress({ tasks, runState, overviewReady: true });
    assert.ok(partial.fraction < 1);
    assert.doesNotMatch(partial.label, /100%/);
  }
  const unknown = promptProgress({ runState: 'running' });
  assert.equal(unknown.fraction, null);
  assert.notEqual(progressBar(unknown, 8, { now: 0 }), progressBar(unknown, 8, { now: 180 }));
  assert.equal(progressBar(unknown, 8, { now: 0, reducedMotion: true }), progressBar(unknown, 8, { now: 999, reducedMotion: true }));
});

test('native todo updates feed measurable prompt progress', () => {
  const parsed = parseRunLine(JSON.stringify({ type: 'tool_use', part: { tool: 'todowrite', state: { status: 'completed', input: { todos: [
    { id: 'a', content: 'Implement', status: 'completed' }, { id: 'b', content: 'Verify', status: 'in_progress' },
  ] } } } }));
  const app = new App({ inputMode: true, color: false });
  app.startRun(); app.setPromptTasks(parsed.tasks);
  assert.equal(app.getPromptProgress().fraction, 1 / 3);
  assert.equal(app.promptTasks[1].state, 'running');
});

test('overview includes every task outcome, failure reason and verification report', () => {
  const text = renderOverview(outcomes());
  for (const value of ['## Completed', '## Not finished', '## Verification', 'src/feature.js', 'regression failed', 'dependency did not complete: tests', 'cancelled before completion', 'npm test: 1 failure']) assert.ok(text.includes(value), value);
  const payload = buildOverviewPrompt(outcomes());
  for (const id of ['build', 'tests', 'review', 'docs']) assert.ok(payload.includes(id));
  assert.doesNotMatch(text, /Outcome: completed/);
  assert.equal(unfinishedRecap('## Not finished\n- None.\n## Verification\npassed'), '');
  assert.equal(unfinishedRecap('```md\n## Not finished\nExample text.\n```'), '');
  const partial = '## Completed\nFixed the bug.\n## Not finished\nCould not run the tests.\n## Verification\nBlocked.';
  assert.equal(buildOverviewData({ state: 'done', report: partial }).state, 'partial');
});

test('reviewed completion and its limitations survive into the closing overview', () => {
  const data = buildOverviewData({ state: 'done', tasks: [{ id: 'map', agent: 'explorer', state: 'completed' }], workers: [{ taskId: 'map',
    output: 'Mapped modules. THEFACTORY_TASK_RESULT: incomplete', acceptanceStatus: 'completed', limitations: 'README absent.',
    acceptanceReview: { decision: 'completed', reason: 'Mapping was supplied from source.', evidence: ['some concrete supporting source evidence'] },
  }] });
  assert.equal(data.state, 'done');
  assert.match(renderOverview(data), /Acceptance reviewed: Mapping was supplied from source/);
  assert.match(renderOverview(data), /README absent/);
  assert.match(buildOverviewPrompt(data), /supersedes a worker/);
  assert.match(buildOverviewPrompt(data), /Mapping was supplied from source/);
});

test('orchestrator synthesizes all outcomes in a text-only turn with a complete fallback', async () => {
  let called = false;
  const result = await synthesizeOverview(outcomes(), { launcher: async (options) => {
    called = true;
    assert.equal(options.agent, 'orchestrator');
    assert.equal(options.reportOnly, true);
    assert.match(options.task, /regression failed/);
    options.onEvent({ text: 'The feature was implemented.', logEntry: { id: 'part1' } });
    options.onEvent({ text: 'Tests failed and review remains blocked.', logEntry: { id: 'part2' } });
    return { result: { code: 0 } };
  } });
  assert.equal(called, true);
  assert.equal(result.synthesized, true);
  assert.match(result.text, /The feature was implemented/);
  assert.match(result.text, /review remains blocked/);
  assert.match(result.text, /docs: Update docs — cancelled/);
  const fallback = await synthesizeOverview(outcomes(), { launcher: async () => { throw new Error('provider unavailable'); } });
  assert.equal(fallback.synthesized, false);
  assert.match(fallback.text, /src\/feature.js/);
  assert.match(fallback.text, /provider unavailable/);
  const controller = new AbortController(); controller.abort();
  await synthesizeOverview(outcomes(), { signal: controller.signal, launcher: () => assert.fail('cancelled runs do not request a recap') });
});

test('report-only role configuration denies tools while preserving selected models', () => {
  const input = { agents: { orchestrator: { model: 'fixture/selected', permissions: [{ action: '*', resource: '*', effect: 'allow' }] } } };
  const result = JSON.parse(agentPromptsRunEnv({ OPENCODE_CONFIG_CONTENT: JSON.stringify(input) }, { reportOnly: true }).OPENCODE_CONFIG_CONTENT);
  assert.equal(result.agents.orchestrator.model, 'fixture/selected');
  assert.deepEqual(result.agents.orchestrator.permissions, [{ action: '*', resource: '*', effect: 'deny' }]);
  assert.equal(input.agents.orchestrator.permissions[0].effect, 'allow');
});

test('overview opens at the beginning, reopens, and preserves the complete native recap', () => {
  for (const [width, height] of [[60, 24], [100, 40]]) {
    const app = new App({ width, height, inputMode: true, color: false });
    app.startRun({ objective: 'Fix the bug' }); app.finishRun('done');
    const native = '## Completed\nFixed src/a.js.\n## Not finished\nNone.\n## Verification\nnode --test: passed.';
    app.setCompletionOverview(renderOverview(buildOverviewData({ objective: 'Fix the bug', state: 'done', report: native })));
    const text = app.snapshot();
    assert.match(text, /OVERVIEW: ORCHESTRATOR/);
    assert.match(text, /100% complete/);
    assert.match(text, /Fixed src\/a.js/);
    assert.match(text, /Verification/);
    assert.ok(text.split('\n').every((line) => displayWidth(line) <= width));
    app.closeLog(); assert.equal(app.openOverview(), true);
    app.cycleLogAgent(1); assert.equal(app.logView.overview, false);
    app.startRun(); assert.equal(app.completionOverview, null);
  }
});
