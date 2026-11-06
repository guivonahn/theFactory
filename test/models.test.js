import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GO_MODEL_IDS, cycleConfigValue, usesNolimit } from '../src/main.js';
import { applyModelToAllAgents } from '../src/nolimit.js';

const config = JSON.parse(
  readFileSync(new URL('../config/opencode/opencode.json', import.meta.url), 'utf8'),
);

const EXPECTED_AGENT_MODELS = {
  orchestrator: 'opencode-go/glm-5.3',
  architect: 'opencode-go/deepseek-v4-pro',
  explorer: 'opencode-go/mimo-v2.6-flash',
  developer: 'opencode-go/kimi-k3.1-pro',
  reviewer: 'opencode-go/claude-haiku-5-5',
  security: 'opencode-go/grok-4.7',
  tester: 'opencode-go/glm-5.3-flash',
};

test('the template pins the default and all seven agents to OpenCode Go', () => {
  assert.equal(config.model, 'opencode-go/glm-5.3');
  assert.ok(config.model.startsWith('opencode-go/'));
  assert.equal(Object.keys(config.agents).length, 7);

  for (const [name, expectedModel] of Object.entries(EXPECTED_AGENT_MODELS)) {
    const model = config.agents[name]?.model;
    assert.equal(typeof model, 'string', `${name} has a configured model`);
    assert.ok(model.startsWith('opencode-go/'), `${name} uses OpenCode Go`);
    assert.equal(model, expectedModel);
  }
});

test('configured agent models are listed in the exported OpenCode Go presets', () => {
  assert.equal(GO_MODEL_IDS.length, 10);
  assert.equal(new Set(GO_MODEL_IDS).size, GO_MODEL_IDS.length, 'presets are unique');
  for (const model of GO_MODEL_IDS) {
    assert.ok(model.startsWith('opencode-go/'), `${model} uses OpenCode Go`);
  }
  for (const [name, agent] of Object.entries(config.agents)) {
    assert.ok(GO_MODEL_IDS.includes(agent.model), `${name} model is in GO_MODEL_IDS`);
  }
});

test('provider policy allows OpenCode Go after the broad deny', () => {
  const policies = config.experimental.policies;
  const broadDeny = policies.findIndex(
    (policy) => policy.action === 'provider.use' && policy.resource === '*' && policy.effect === 'deny',
  );
  const goAllow = policies.findIndex(
    (policy) => policy.action === 'provider.use' && policy.resource === 'opencode-go' && policy.effect === 'allow',
  );

  assert.ok(broadDeny >= 0, 'broad provider deny exists');
  assert.ok(goAllow > broadDeny, 'OpenCode Go allow follows the broad deny');
  for (const resource of ['opencode', 'OC-NOLIMIT']) {
    assert.ok(policies.some(
      (policy) => policy.action === 'provider.use' && policy.resource === resource && policy.effect === 'allow',
    ), `${resource} allow is preserved`);
  }
  assert.ok(config.provider?.['OC-NOLIMIT'], 'OC-NOLIMIT provider block is preserved');
});

test('model cycling starts with the ordered OpenCode Go presets', () => {
  const options = { model: null };
  assert.equal(cycleConfigValue(options, 'model', 1), 'opencode-go/glm-5.3');
  assert.equal(cycleConfigValue(options, 'model', 1), 'opencode-go/deepseek-v4-pro');
});

test('the OC-NOLIMIT proxy is only required for OC-NOLIMIT selections', () => {
  assert.equal(usesNolimit({ model: 'opencode-go/glm-5.3' }), false);
  assert.equal(usesNolimit({ model: 'opencode-go/glm-5.3', fallbackModels: ['opencode-go/kimi-k3.1-pro'] }), false);
  assert.equal(usesNolimit({ model: 'OC-NOLIMIT/big-pickle' }), true);
  assert.equal(usesNolimit({ fallbackModels: ['opencode-go/glm-5.3', 'OC-NOLIMIT/big-pickle'] }), true);
  assert.equal(usesNolimit({ nolimit: 'status' }), true);
});

test('applyModelToAllAgents(null) restores the template Go lineup', () => {
  const dir = mkdtempSync(join(tmpdir(), 'thefactory-models-'));
  const configFile = join(dir, 'opencode.json');
  const initial = {
    model: 'OC-NOLIMIT/big-pickle',
    agents: Object.fromEntries(Object.keys(EXPECTED_AGENT_MODELS).map((name) => [name, { model: 'OC-NOLIMIT/big-pickle' }])),
  };
  writeFileSync(configFile, JSON.stringify(initial));

  try {
    const result = applyModelToAllAgents(null, { configFile });
    assert.equal(result.ok, true);
    const restored = JSON.parse(readFileSync(configFile, 'utf8'));
    assert.equal(restored.model, config.model);
    for (const [name, expectedModel] of Object.entries(EXPECTED_AGENT_MODELS)) {
      assert.equal(restored.agents[name].model, expectedModel, `${name} restored to its Go default`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
