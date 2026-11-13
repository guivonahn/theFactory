import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { agentPromptsRunEnv } from '../src/agentPrompts.js';
import { createSkillRegistry, loadSkills } from '../src/skills.js';
import { buildWorkerPrompt, completedWorker } from '../src/worker.js';
import { parsePlan } from '../src/plan.js';

test('role prompts preserve configured models, instructions and permissions without duplication', () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-prompts-'));
  try {
    const configFile = join(dir, 'config.json');
    writeFileSync(configFile, JSON.stringify({ agents: { developer: { system: 'Keep the project style.' } } }));
    const input = { model: 'custom/model', agents: { developer: { model: 'custom/dev', permissions: [{ action: 'edit', resource: '*', effect: 'ask' }] } } };
    const env = agentPromptsRunEnv({ OPENCODE_CONFIG_CONTENT: JSON.stringify(input) }, { configFile });
    const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
    assert.equal(config.model, input.model);
    assert.equal(config.agents.developer.model, 'custom/dev');
    assert.deepEqual(config.agents.developer.permissions, input.agents.developer.permissions);
    assert.ok(config.agents.developer.system.startsWith('Keep the project style.'));
    const again = JSON.parse(agentPromptsRunEnv(env, { configFile }).OPENCODE_CONFIG_CONTENT);
    assert.equal(again.agents.developer.system, config.agents.developer.system);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('bundled skills work outside theFactory and route only to the assigned role', () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-target-'));
  try {
    const registry = createSkillRegistry(loadSkills(undefined, { projectDir: dir }));
    assert.ok(registry.get('terminal-interface'));
    assert.equal(registry.get('architecture-map').agent, 'architect');
    assert.equal(registry.get('README'), null);
    const prompt = buildWorkerPrompt({ objective: 'Implement terminal animation and review security tests', task: { id: 't1', agent: 'developer', readOnly: false }, registry });
    assert.match(prompt, /SKILL: terminal-interface/);
    assert.doesNotMatch(prompt, /SKILL: code-review|SKILL: security-audit|SKILL: test-generation/);
    const env = agentPromptsRunEnv({}, { configFile: join(dir, 'missing'), registry, skillText: 'review security tests' });
    const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
    assert.match(config.agents.reviewer.system, /SKILL: code-review/);
    assert.doesNotMatch(config.agents.developer.system, /SKILL: code-review/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('planner and worker outcomes respect role capabilities and actual failure', () => {
  assert.equal(parsePlan('{"tasks":[{"id":"t1","agent":"developer"}]}')[0].readOnly, false);
  assert.throws(() => parsePlan('{"tasks":[{"id":"t1","agent":"tester","readOnly":false}]}'), /read-only/);
  assert.throws(() => completedWorker({ state: 'failed', error: 'process failed' }), /process failed/);
  assert.equal(completedWorker({ state: 'completed', output: 'verified' }).output, 'verified');
});
