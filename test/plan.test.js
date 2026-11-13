import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPlanningPrompt,
  extractPlanJson,
  parsePlan,
  fallbackPlan,
} from '../src/plan.js';

test('buildPlanningPrompt carries objective, task bound and mode', () => {
  const prompt = buildPlanningPrompt('fix the failing tests', { maxTasks: 4, sequential: false });
  assert.ok(prompt.includes('Objective: fix the failing tests'));
  assert.ok(prompt.includes('At most 4 tasks'));
  assert.ok(prompt.includes('{"tasks":['));
  assert.ok(prompt.includes('"agent":"explorer"'));
  const sequential = buildPlanningPrompt('x', { maxTasks: 2, sequential: true });
  assert.ok(sequential.includes('strictly one after another'));
});

test('investigation plans allow one reader and do not require optional files or a duplicate summary', () => {
  const prompt = buildPlanningPrompt('how does this project work?');
  assert.match(prompt, /one task is valid/);
  assert.match(prompt, /Prefer one explorer/);
  assert.match(prompt, /do not gate all research on a preliminary map/);
  assert.match(prompt, /Finding an optional file absent is a valid observation/);
  assert.match(prompt, /Do not add a summary-only task/);
});

test('extractPlanJson strips fences, prose, and survives braces in strings', () => {
  const fenced = 'Sure!\n```json\n{"tasks":[{"id":"t1","text":"literal } brace"}]}\n```\ndone';
  assert.equal(extractPlanJson(fenced), '{"tasks":[{"id":"t1","text":"literal } brace"}]}');
  const plain = 'The plan is {"tasks":[{"id":"t1"}]} — hope this helps.';
  assert.equal(extractPlanJson(plain), '{"tasks":[{"id":"t1"}]}');
  assert.equal(extractPlanJson('no json here'), null);
  assert.equal(extractPlanJson('{"unterminated": "nope'), null);
});

test('parsePlan normalizes to scheduler-ready tasks (validateTasks)', () => {
  const reply = '```json\n{"tasks":[\n' +
    '{"id":"t1","title":"read code","agent":"explorer","deps":[],"files":["src/a.js"],"readOnly":true},\n' +
    '{"id":"t2","title":"write code","agent":"wizard","deps":["t1"],"files":["src/a.js"],"readOnly":false}\n' +
    ']}\n```';
  const tasks = parsePlan(reply);
  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].agent, 'explorer');
  assert.equal(tasks[1].agent, 'developer'); // unknown role coerced
  assert.equal(tasks[1].readOnly, false);
  assert.deepEqual(tasks[1].deps, ['t1']);
});

test('parsePlan rejects unusable output at parse and shape level', () => {
  assert.throws(() => parsePlan('{"tasks":[]}'), /no tasks/);
  assert.throws(() => parsePlan('I will not follow the format.'), /no JSON object/);
  assert.throws(() => parsePlan('{"tasks":[{},{}]}'), /missing id/);
  assert.throws(() => parsePlan('{"tasks":[_],}'), /invalid/);
});

test('parsePlan accepts a bare tasks array (model leniency)', () => {
  const tasks = parsePlan('[{"id":"t1","agent":"tester"}]');
  assert.equal(tasks[0].agent, 'tester');
  assert.equal(tasks[0].readOnly, true); // default from normalize + validate
});

test('fallbackPlan yields one developer task that never blocks', () => {
  const tasks = fallbackPlan('deploy the thing');
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].agent, 'developer');
  assert.equal(tasks[0].readOnly, false);
  assert.equal(tasks[0].deps.length, 0);
  const empty = fallbackPlan('');
  assert.equal(empty[0].readOnly, true); // nothing to write
});
