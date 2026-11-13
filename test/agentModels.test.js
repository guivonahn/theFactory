import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { effectiveAgentModels, loadAgentModels, MODEL_AGENT_KEYS, resolvedModelConfig, saveAgentModels, syncProfileModel } from '../src/agentModels.js';
import { applyProfileToAllAgents, FREE_AGENT_MODELS } from '../src/profiles.js';
import { argsForRun } from '../src/run.js';
import { configModelChoices, cycleConfigValue, GO_MODEL_IDS } from '../src/main.js';
import { customizeModel } from '../src/profileConfig.js';
import { syncModelRouting } from '../src/coarena.js';
import { launchRunWithFallback } from '../src/run.js';
import { createWorkerManager } from '../src/worker.js';
import { App } from '../src/app.js';
import { displayWidth } from '../src/canvas.js';

function fixture(dir) {
  const bin = join(dir, 'fake-opencode');
  writeFileSync(bin, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const model = args[args.indexOf('-m')+1];
const entry = { model, args, config: JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || '{}') };
fs.appendFileSync(process.env.AGENT_MODEL_TEST_CALLS, JSON.stringify(entry) + '\\n');
console.log(JSON.stringify(model === process.env.AGENT_MODEL_TEST_FAIL ? {type:'error',error:{message:'429 quota exhausted'}} : {type:'text',part:{text:'OK'}}));
`, { mode: 0o700 });
  return bin;
}

test('individual model choices persist, sanitize invalid entries, and survive profiles', () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-agent-settings-'));
  try {
    const path = join(dir, 'preferences.json');
    const models = { developer: 'coarena-1/claude-fable-5-2', reviewer: 'opencode-go/glm-5.3' };
    assert.equal(saveAgentModels({ ...models, unknown: 'x/y', explorer: 'invalid' }, path).ok, true);
    assert.deepEqual(loadAgentModels(path), models);
    const options = { agentModels: models, profile: 'high' };
    assert.equal(effectiveAgentModels(options).reviewer, 'opencode-go/glm-5.3#high');
    options.profile = 'free';
    assert.ok(Object.values(effectiveAgentModels(options)).every((model) => model.endsWith('-free')));
    assert.deepEqual(loadAgentModels(path), models, 'temporary profiles leave saved base models intact');
    options.profile = null;
    assert.deepEqual(effectiveAgentModels(options), models);
    cycleConfigValue(options, 'agent:reviewer', 1);
    assert.equal(options.agentModels.developer, models.developer, 'editing one agent leaves another untouched');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('every agent selector and bottom settings remain visible and reachable at 60x24', () => {
  const app = new App({ width: 60, height: 24, color: false, mode: 'task' });
  app.openConfig({ agentModels: { developer: 'coarena-1/claude-fable-5-2' } });
  const seen = new Set();
  for (let i = 0; i < 17; i += 1) {
    const snap = app.snapshot();
    assert.ok(snap.split('\n').every((line) => displayWidth(line) <= 60));
    const key = app.configView.selected;
    if (key.startsWith('agent:')) {
      seen.add(key.slice(6));
      assert.match(snap, new RegExp(`› ${key.slice(6)}`));
    }
    if (key === 'volume') assert.match(snap, /› volume/);
    app.moveConfigSelection(1);
  }
  assert.deepEqual([...seen], MODEL_AGENT_KEYS);
  app.resize(100, 40);
  assert.match(app.snapshot(), /coarena-1\/claude-fable-5-2/);
});

test('selected root and subagent models reach OpenCode, with temporary key fallback', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-agent-routing-'));
  try {
    const path = join(dir, 'calls.jsonl');
    const agentModels = { orchestrator: 'coarena-1/claude-fable-5-2', developer: 'opencode-go/kimi-k3.1-pro', reviewer: 'coarena-2/claude-opus-5-5' };
    const before = JSON.stringify(agentModels);
    const result = await launchRunWithFallback({
      bin: fixture(dir), task: 'hello', model: 'coarena-1/claude-opus-5-5', agentModels, autoFallback: true,
      fallbackModels: ['opencode-go/glm-5.3'],
      env: { COARENA_API_KEY_1: 'test-one', COARENA_API_KEY_2: 'test-two', AGENT_MODEL_TEST_CALLS: path, AGENT_MODEL_TEST_FAIL: agentModels.orchestrator },
    });
    assert.equal(result.result.code, 0);
    assert.equal(result.model, 'coarena-2/claude-fable-5-2');
    assert.equal(JSON.stringify(agentModels), before);
    const calls = readFileSync(path, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].model, agentModels.orchestrator);
    assert.equal(calls[0].config.agents.developer.model, agentModels.developer);
    assert.equal(calls[0].config.agents.reviewer.model, agentModels.reviewer);
    assert.equal(calls[1].config.agents.orchestrator.model, result.model);
    assert.equal(calls[1].config.agents.developer.model, agentModels.developer);
    assert.equal(calls[1].config.agents.reviewer.model, agentModels.reviewer);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('every agent can pick Coarena independently while the preset and other agents stay intact', () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-single-coarena-'));
  const keys = { COARENA_API_KEY_1: 'one', COARENA_API_KEY_2: 'two' };
  try {
    const path = join(dir, 'opencode.json');
    writeFileSync(path, readFileSync(new URL('../config/opencode/opencode.json', import.meta.url)));
    applyProfileToAllAgents('high', { configFile: path });
    for (const agent of MODEL_AGENT_KEYS) {
      const options = { profile: 'high', model: null, agentModels: {}, autoFallback: true };
      syncModelRouting(options, GO_MODEL_IDS, keys);
      const before = resolvedModelConfig(options, { configFile: path });
      assert.ok(Object.values(before.agentModels).every((model) => model.startsWith('opencode-go/')));
      const key = `agent:${agent}`;
      const models = configModelChoices(options, key, { env: keys });
      for (const id of ['coarena-1/claude-opus-5-5', 'coarena-2/claude-opus-5-5', 'coarena-1/claude-fable-5-2', 'coarena-2/claude-fable-5-2']) assert.ok(models.includes(id));
      const app = new App({ width: 60, height: 24, color: false });
      app.openConfig({ effectiveAgentModels: before.agentModels });
      app.openModelPicker(key, models, before.agentModels[agent]);
      app.moveModelPicker(models.indexOf('coarena-2/claude-fable-5-2') - app.modelPicker.selected);
      assert.match(app.snapshot(), new RegExp(`Base model: ${agent.toUpperCase()}`));
      assert.match(app.snapshot(), new RegExp(`Only ${agent} will change`));
      assert.match(app.snapshot(), /coarena-2\/claude-fable-5-2/);
      const choice = app.modelPickerChoice();
      customizeModel(options, agent, choice.model, before);
      const after = effectiveAgentModels(options);
      assert.equal(after[agent], 'coarena-2/claude-fable-5-2');
      for (const other of MODEL_AGENT_KEYS.filter((key) => key !== agent)) assert.equal(after[other], before.agentModels[other]);
      assert.equal(Object.values(after).filter((model) => model.startsWith('coarena-')).length, 1);
      app.closeModelPicker();
      assert.equal(app.configView.open, true);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Coarena choices remain visible when individual pickers open on late free models', () => {
  const keys = { COARENA_API_KEY_1: 'one', COARENA_API_KEY_2: 'two' };
  const currentModels = {
    ...FREE_AGENT_MODELS,
    developer: 'opencode/nemotron-3.5-super-vl-free',
  };
  const coarena = ['coarena-1/claude-opus-5-5', 'coarena-2/claude-opus-5-5', 'coarena-1/claude-fable-5-2', 'coarena-2/claude-fable-5-2'];
  for (const [width, height] of [[60, 24], [100, 28], [100, 32]]) {
    for (const agent of MODEL_AGENT_KEYS) {
      const app = new App({ width, height, color: false });
      const key = `agent:${agent}`;
      const models = configModelChoices({ agentModels: currentModels }, key, { env: keys });
      app.openConfig({});
      app.openModelPicker(key, models, currentModels[agent]);
      let frame = app.snapshot(); // First render, without navigating toward Coarena.
      for (const id of coarena) assert.ok(frame.includes(id), `${agent} at ${width}x${height} initially shows ${id}`);
      assert.equal(app.modelPickerChoice().model, currentModels[agent], 'opening preserves the current model selection');
      assert.ok(frame.split('\n').find((line) => line.includes('› '))?.includes(currentModels[agent]));
      assert.ok(frame.split('\n').every((line) => displayWidth(line) <= width));
      app.moveModelPicker(1);
      frame = app.snapshot();
      for (const id of coarena) assert.ok(frame.includes(id), `${id} remains visible while scrolling`);
      app.jumpModelPickerToCoarena();
      assert.equal(app.modelPickerChoice().model, coarena[0]);
      assert.match(app.snapshot(), /C Coarena/);
    }
  }
});

test('model picker remains usable without Coarena credentials and with a short model list', () => {
  const app = new App({ width: 60, height: 24, color: false });
  const choices = ['opencode-go/glm-5.3', 'opencode-go/kimi-k3.1-pro'];
  app.openConfig({});
  app.openModelPicker('agent:developer', choices, choices[1]);
  app.jumpModelPickerToCoarena();
  assert.equal(app.modelPickerChoice().model, choices[1]);
  assert.match(app.snapshot(), /opencode-go\/glm-5.3/);
  assert.match(app.snapshot(), /opencode-go\/kimi-k3.1-pro/);
  assert.doesNotMatch(app.snapshot(), /C Coarena/);
});

test('an individual Coarena worker fallback changes only that agent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-isolated-retry-'));
  try {
    const path = join(dir, 'calls.jsonl');
    const configFile = join(dir, 'opencode.json');
    writeFileSync(configFile, readFileSync(new URL('../config/opencode/opencode.json', import.meta.url)));
    applyProfileToAllAgents('high', { configFile });
    const options = { profile: 'high', model: null, agentModels: {} };
    customizeModel(options, 'developer', 'coarena-1/claude-fable-5-2', resolvedModelConfig(options, { configFile }));
    const assigned = effectiveAgentModels(options);
    const backup = 'opencode-go/kimi-k3.1-pro#high';
    const result = await launchRunWithFallback({
      bin: fixture(dir), task: 'hello', agent: 'developer', model: options.model, agentModels: assigned, fallbackModels: [backup],
      env: { COARENA_API_KEY_1: 'one', AGENT_MODEL_TEST_CALLS: path, AGENT_MODEL_TEST_FAIL: assigned.developer },
    });
    assert.equal(result.result.code, 0);
    const calls = readFileSync(path, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].config.agents.developer.model, assigned.developer);
    assert.equal(calls[1].config.agents.developer.model, backup);
    for (const call of calls) {
      for (const agent of MODEL_AGENT_KEYS.filter((key) => key !== 'developer')) assert.equal(call.config.agents[agent].model, assigned[agent]);
    }
    assert.deepEqual(effectiveAgentModels(options), assigned);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('parallel workers launch the base model assigned to their own role', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-agent-workers-'));
  const old = process.env.AGENT_MODEL_TEST_CALLS;
  try {
    process.env.AGENT_MODEL_TEST_CALLS = join(dir, 'calls.jsonl');
    const models = { developer: 'opencode-go/kimi-k3.1-pro', reviewer: 'opencode-go/glm-5.3' };
    const manager = createWorkerManager({ model: 'opencode-go/deepseek-v4-pro', agentModels: models });
    const bin = fixture(dir);
    const first = manager.start({ task: { id: 'a', agent: 'developer' }, bin });
    const second = manager.start({ task: { id: 'b', agent: 'reviewer' }, bin });
    await Promise.all([first.done, second.done]);
    assert.equal(first.record.model, models.developer);
    assert.equal(second.record.model, models.reviewer);
    const calls = readFileSync(process.env.AGENT_MODEL_TEST_CALLS, 'utf8').trim().split('\n').map(JSON.parse);
    for (const call of calls) {
      const role = call.args[call.args.indexOf('--agent') + 1];
      assert.equal(call.model, models[role]);
      assert.ok(call.args.includes('--standalone'));
    }
  } finally {
    if (old === undefined) delete process.env.AGENT_MODEL_TEST_CALLS;
    else process.env.AGENT_MODEL_TEST_CALLS = old;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('profile changes immediately refresh all config rows with resolved models and variants', () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-profile-config-'));
  try {
    const path = join(dir, 'opencode.json');
    writeFileSync(path, readFileSync(new URL('../config/opencode/opencode.json', import.meta.url)));
    const saved = { developer: 'opencode-go/kimi-k3.1-pro' };
    const options = { model: null, profile: null, agentModels: { ...saved } };
    const app = new App({ width: 100, height: 32, color: false });
    app.openConfig({});
    for (const [profile, reviewer, developer] of [
      ['low', 'opencode-go/claude-haiku-5-5#low', 'opencode-go/kimi-k3.1-pro#low'],
      ['medium', 'opencode-go/claude-haiku-5-5#medium', 'opencode-go/kimi-k3.1-pro#low'],
      ['high', 'opencode-go/claude-haiku-5-5#high', 'opencode-go/kimi-k3.1-pro#high'],
      ['free', FREE_AGENT_MODELS.reviewer, FREE_AGENT_MODELS.developer],
      [null, 'opencode-go/claude-haiku-5-5', 'opencode-go/kimi-k3.1-pro'],
    ]) {
      cycleConfigValue(options, 'profile');
      assert.equal(options.profile, profile);
      assert.equal(applyProfileToAllAgents(profile, { configFile: path }).ok, true);
      syncProfileModel(options);
      const resolved = resolvedModelConfig(options, { configFile: path });
      app.updateConfigInfo({ ...options, model: resolved.model, effectiveAgentModels: resolved.agentModels });
      const frame = app.snapshot();
      assert.equal(Object.keys(resolved.agentModels).length, 7);
      assert.equal(resolved.agentModels.reviewer, reviewer);
      assert.equal(resolved.agentModels.developer, developer);
      assert.match(frame, new RegExp(reviewer.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.match(frame, new RegExp(developer.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.doesNotMatch(frame, /\(shared\/default\)/);
      assert.deepEqual(options.agentModels, {}, 'selecting a preset uses its clean lineup');
    }
    const displayed = resolvedModelConfig(options, { configFile: path }).agentModels;
    cycleConfigValue(options, 'agent:reviewer', 1, { agentModels: displayed });
    assert.equal(options.agentModels.reviewer, 'opencode-go/grok-4.7', 'cycling starts from the visible inherited model');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the displayed shared variant is also sent to OpenCode, and free clears paid overrides', () => {
  const options = { model: 'opencode-go/glm-5.3#max', profile: 'high' };
  syncProfileModel(options);
  assert.equal(options.model, 'opencode-go/glm-5.3#high');
  assert.ok(argsForRun(options).includes('opencode-go/glm-5.3#high'));
  cycleConfigValue(options, 'model');
  assert.equal(options.model, 'opencode-go/deepseek-v4-pro#high', 'model cycling follows the visible base and retains the profile');
  options.model = 'opencode-go/glm-5.3#high';
  options.profile = 'medium';
  syncProfileModel(options);
  assert.equal(options.model, 'opencode-go/glm-5.3#low');
  options.profile = null;
  syncProfileModel(options);
  assert.equal(options.model, 'opencode-go/glm-5.3');
  options.profile = 'free';
  syncProfileModel(options);
  assert.equal(options.model, null);
  assert.deepEqual(resolvedModelConfig(options).agentModels, FREE_AGENT_MODELS);
});
