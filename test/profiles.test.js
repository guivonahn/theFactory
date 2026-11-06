import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FREE_AGENT_MODELS,
  MODEL_VARIANTS,
  PROFILE_ORDER,
  VARIANT_ORDER,
  applyProfileToAllAgents,
  pickVariant,
  withProfile,
} from '../src/profiles.js';

test('profile and variant orders and configured model mappings are exact', () => {
  assert.deepEqual(PROFILE_ORDER, ['low', 'medium', 'high', 'free']);
  assert.deepEqual(VARIANT_ORDER, ['none', 'low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(FREE_AGENT_MODELS, {
    orchestrator: 'opencode/crouton-alpha-free',
    architect: 'opencode/deepseek-v4.1-flash-free',
    explorer: 'opencode/mimo-v2.6-flash-free',
    developer: 'opencode/flint-40b-free',
    reviewer: 'opencode/beam-free',
    security: 'opencode/nemotron-3.5-super-vl-free',
    tester: 'opencode/nemotron-3.5-lightning-free',
  });
  assert.deepEqual(MODEL_VARIANTS, {
    'glm-5.3': ['low', 'high', 'max'],
    'glm-5.3-flash': ['low', 'high', 'max'],
    'deepseek-v4-pro': ['high', 'max'],
    'kimi-k3.1-pro': ['low', 'high', 'max'],
    'claude-haiku-5-5': ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
    'grok-4.7': ['low', 'medium', 'high', 'xhigh'],
    'mimo-v2.6-flash': [],
  });
});

test('pickVariant uses exact matches and nearest lower-effort fallbacks', () => {
  assert.equal(pickVariant('opencode-go/glm-5.3', 'high'), 'high');
  assert.equal(pickVariant('opencode-go/claude-haiku-5-5', 'medium'), 'medium');
  assert.equal(pickVariant('opencode-go/glm-5.3', 'medium'), 'low');
  assert.equal(pickVariant('opencode-go/deepseek-v4-pro', 'low'), 'high');
  assert.equal(pickVariant('opencode-go/mimo-v2.6-flash', 'high'), null);
  assert.equal(pickVariant('opencode-go/unknown', 'high'), null);
  assert.equal(pickVariant('opencode-go/glm-5.3', null), null);
  assert.equal(pickVariant('opencode-go/glm-5.3', 'free'), null);
});

test('withProfile strips an old suffix before applying a profile', () => {
  assert.equal(withProfile('opencode-go/glm-5.3#max', 'medium'), 'opencode-go/glm-5.3#low');
  assert.equal(withProfile('opencode-go/grok-4.7#low', 'high'), 'opencode-go/grok-4.7#high');
  assert.equal(withProfile('opencode-go/glm-5.3#max', null), 'opencode-go/glm-5.3');
  assert.equal(withProfile('opencode-go/mimo-v2.6-flash#high', 'high'), 'opencode-go/mimo-v2.6-flash');
});

test('applyProfileToAllAgents updates every agent and can strip all suffixes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'thefactory-profiles-'));
  const configFile = join(dir, 'opencode.json');
  const initial = {
    model: 'opencode-go/glm-5.3#low',
    agents: {
      orchestrator: { model: 'opencode-go/glm-5.3#max' },
      architect: { model: 'opencode-go/deepseek-v4-pro' },
      developer: { model: 'opencode-go/kimi-k3.1-pro#low' },
    },
  };
  writeFileSync(configFile, JSON.stringify(initial));

  try {
    const high = applyProfileToAllAgents('high', { configFile });
    assert.equal(high.ok, true);
    assert.equal(high.agents, 3);
    assert.equal(high.error, null);
    assert.deepEqual(high.applied, [
      { agent: 'orchestrator', model: 'opencode-go/glm-5.3#high' },
      { agent: 'architect', model: 'opencode-go/deepseek-v4-pro#high' },
      { agent: 'developer', model: 'opencode-go/kimi-k3.1-pro#high' },
    ]);
    let saved = JSON.parse(readFileSync(configFile, 'utf8'));
    assert.equal(saved.model, 'opencode-go/glm-5.3#high');
    for (const agent of Object.values(saved.agents)) {
      assert.ok(agent.model.endsWith('#high'), `${agent.model} has the high variant`);
    }

    const cleared = applyProfileToAllAgents(null, { configFile });
    assert.equal(cleared.ok, true);
    assert.equal(cleared.agents, 3);
    saved = JSON.parse(readFileSync(configFile, 'utf8'));
    assert.equal(saved.model, 'opencode-go/glm-5.3');
    for (const agent of Object.values(saved.agents)) {
      assert.ok(!agent.model.includes('#'), `${agent.model} has no variant suffix`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the free profile pins every agent to a free model and back restores Go', () => {
  const dir = mkdtempSync(join(tmpdir(), 'thefactory-profiles-'));
  const configFile = join(dir, 'opencode.json');
  const initial = {
    model: 'opencode-go/glm-5.3#low',
    agents: Object.fromEntries(
      Object.keys(FREE_AGENT_MODELS).map((agent) => [agent, { model: 'opencode-go/glm-5.3#low' }]),
    ),
  };
  writeFileSync(configFile, JSON.stringify(initial));

  try {
    const free = applyProfileToAllAgents('free', { configFile });
    assert.equal(free.ok, true);
    assert.equal(free.agents, 7);
    let saved = JSON.parse(readFileSync(configFile, 'utf8'));
    assert.equal(saved.model, FREE_AGENT_MODELS.orchestrator);
    for (const [agent, model] of Object.entries(FREE_AGENT_MODELS)) {
      assert.equal(saved.agents[agent].model, model);
      assert.ok(model.startsWith('opencode/') && model.endsWith('-free'));
    }

    // Idempotent: a second free apply does not accumulate variants.
    const again = applyProfileToAllAgents('free', { configFile });
    assert.equal(again.ok, true);
    saved = JSON.parse(readFileSync(configFile, 'utf8'));
    assert.equal(saved.agents.developer.model, FREE_AGENT_MODELS.developer);

    const high = applyProfileToAllAgents('high', { configFile });
    assert.equal(high.ok, true);
    saved = JSON.parse(readFileSync(configFile, 'utf8'));
    assert.equal(saved.model, 'opencode-go/glm-5.3#high');
    assert.deepEqual(
      Object.fromEntries(Object.entries(saved.agents).map(([agent, def]) => [agent, def.model])),
      {
        orchestrator: 'opencode-go/glm-5.3#high',
        architect: 'opencode-go/deepseek-v4-pro#high',
        explorer: 'opencode-go/mimo-v2.6-flash',
        developer: 'opencode-go/kimi-k3.1-pro#high',
        reviewer: 'opencode-go/claude-haiku-5-5#high',
        security: 'opencode-go/grok-4.7#high',
        tester: 'opencode-go/glm-5.3-flash#high',
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('applyProfileToAllAgents rejects unknown profiles and missing files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'thefactory-profiles-'));
  try {
    const configFile = join(dir, 'opencode.json');
    const missing = applyProfileToAllAgents('free', { configFile });
    assert.equal(missing.ok, false);
    assert.equal(missing.error, 'opencode.json not found');

    writeFileSync(configFile, JSON.stringify({ agents: {} }));
    const invalid = applyProfileToAllAgents('turbo', { configFile });
    assert.equal(invalid.ok, false);
    assert.equal(invalid.agents, 0);
    assert.match(invalid.error, /unknown profile: turbo/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
