import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { customizeModel, loadProfileConfig, profileConfigPath, restoreProfileConfig, saveProfileConfig, selectProfile } from '../src/profileConfig.js';
import { effectiveAgentModels, resolvedModelConfig } from '../src/agentModels.js';
import { applyProfileToAllAgents, FREE_AGENT_MODELS, FREE_FALLBACK_MODELS } from '../src/profiles.js';
import { cycleConfigValue, parseArgs } from '../src/main.js';
import { syncModelRouting } from '../src/coarena.js';
import { launchRunWithFallback } from '../src/run.js';
import { App } from '../src/app.js';

function setup(profile = 'high') {
  const dir = mkdtempSync(join(tmpdir(), 'factory-custom-profile-'));
  const configFile = join(dir, 'opencode.json');
  writeFileSync(configFile, readFileSync(new URL('../config/opencode/opencode.json', import.meta.url)));
  applyProfileToAllAgents(profile, { configFile });
  const options = { ...parseArgs([]), profile, agentModels: {} };
  return { dir, configFile, options, path: join(dir, 'thefactory', 'config.json') };
}

test('editing one model creates Custom and freezes the preset effort and untouched models', () => {
  const { dir, configFile, options, path } = setup();
  try {
    const before = resolvedModelConfig(options, { configFile });
    cycleConfigValue(options, 'agent:developer', 1, { resolved: before, agentModels: before.agentModels });
    assert.equal(options.profile, 'custom');
    assert.equal(options.customProfile.baseProfile, 'high');
    assert.equal(effectiveAgentModels(options).developer, 'opencode-go/claude-haiku-5-5#high');
    for (const agent of Object.keys(before.agentModels).filter((agent) => agent !== 'developer')) {
      assert.equal(effectiveAgentModels(options)[agent], before.agentModels[agent]);
    }
    assert.equal(saveProfileConfig(options, path).ok, true);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const saved = loadProfileConfig(path);
    const restarted = parseArgs([]);
    restoreProfileConfig(restarted, saved);
    assert.equal(restarted.profile, 'custom');
    assert.deepEqual(effectiveAgentModels(restarted), effectiveAgentModels(options));
    assert.deepEqual(resolvedModelConfig(restarted), resolvedModelConfig(options));
    const app = new App({ width: 100, height: 32, color: false });
    app.openConfig({ ...restarted, customBaseProfile: restarted.customProfile.baseProfile, effectiveAgentModels: effectiveAgentModels(restarted) });
    assert.match(app.snapshot(), /custom \(high\)/);
    assert.match(app.snapshot(), /claude-haiku-5-5#high/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('switching presets preserves the Custom slot and restores the active selection on restart', () => {
  const { dir, configFile, options, path } = setup();
  try {
    const resolved = resolvedModelConfig(options, { configFile });
    customizeModel(options, 'reviewer', 'coarena-2/claude-fable-5-2', resolved);
    const custom = structuredClone(options.customProfile);
    selectProfile(options, 'low');
    applyProfileToAllAgents('low', { configFile });
    assert.deepEqual(options.agentModels, {});
    assert.deepEqual(options.customProfile, custom);
    assert.equal(saveProfileConfig(options, path).ok, true);
    const saved = loadProfileConfig(path);
    const restarted = parseArgs([]);
    restoreProfileConfig(restarted, saved);
    assert.equal(restarted.profile, 'low');
    assert.deepEqual(restarted.customProfile, custom);
    cycleConfigValue(restarted, 'profile', -1); // low -> default
    cycleConfigValue(restarted, 'profile', -1); // default -> custom
    assert.equal(restarted.profile, 'custom');
    assert.deepEqual(effectiveAgentModels(restarted), custom.agentModels);
    const explicit = parseArgs(['--profile', 'free']);
    restoreProfileConfig(explicit, saved);
    assert.equal(explicit.profile, 'free');
    assert.deepEqual(explicit.agentModels, {});
    assert.deepEqual(effectiveAgentModels(explicit), FREE_AGENT_MODELS);
    const explicitCustom = parseArgs(['--profile', 'custom']);
    restoreProfileConfig(explicitCustom, saved);
    assert.deepEqual(effectiveAgentModels(explicitCustom), custom.agentModels);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Custom derived from Free keeps other agents and free fallbacks unchanged', () => {
  const { dir, configFile, options, path } = setup('free');
  try {
    const before = resolvedModelConfig(options, { configFile });
    customizeModel(options, 'developer', 'opencode/flint-40b-free', before);
    syncModelRouting(options, FREE_FALLBACK_MODELS, { COARENA_API_KEY_1: 'not-used' });
    assert.equal(options.profile, 'custom');
    assert.equal(options.customProfile.baseProfile, 'free');
    assert.deepEqual(effectiveAgentModels(options), FREE_AGENT_MODELS);
    assert.ok(options.fallbackModels.every((model) => model.endsWith('-free')));
    customizeModel(options, 'developer', 'coarena-1/claude-fable-5-2');
    for (const [agent, model] of Object.entries(FREE_AGENT_MODELS)) {
      if (agent !== 'developer') assert.equal(effectiveAgentModels(options)[agent], model);
    }
    assert.equal(saveProfileConfig(options, path).ok, true);
    assert.equal(loadProfileConfig(path).customProfile.baseProfile, 'free');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('shared model edits create Custom for all agents; non-model controls do not', () => {
  const { dir, configFile, options, path } = setup('medium');
  try {
    cycleConfigValue(options, 'verbose');
    cycleConfigValue(options, 'volume');
    assert.equal(options.profile, 'medium');
    assert.equal(options.customProfile, undefined);
    const resolved = resolvedModelConfig(options, { configFile });
    cycleConfigValue(options, 'model', 1, { resolved, model: resolved.model });
    assert.equal(options.profile, 'custom');
    assert.equal(options.customProfile.baseProfile, 'medium');
    assert.equal(Object.keys(effectiveAgentModels(options)).length, 7);
    assert.ok(Object.values(effectiveAgentModels(options)).every((model) => model === options.model));
    const first = options.model;
    cycleConfigValue(options, 'model', 1, { resolved: resolvedModelConfig(options), model: resolved.model });
    assert.notEqual(options.model, first, 'a variant does not trap the shared selector on one model');
    assert.equal(saveProfileConfig(options, path).ok, true);
    const flags = parseArgs(['--profile', 'low', '--model', 'opencode-go/kimi-k3.1-pro#max']);
    const requested = flags.model;
    restoreProfileConfig(flags, loadProfileConfig(path));
    applyProfileToAllAgents(flags.profile, { configFile });
    customizeModel(flags, 'model', requested, resolvedModelConfig(flags, { configFile }));
    assert.equal(flags.profile, 'custom');
    assert.equal(flags.customProfile.baseProfile, 'low');
    assert.ok(Object.values(effectiveAgentModels(flags)).every((model) => model === requested), 'explicit CLI model and variant override the saved profile');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('legacy choices migrate, XDG config is respected, and unavailable Custom fails clearly', () => {
  const { dir, configFile } = setup();
  const old = process.env.XDG_CONFIG_HOME;
  try {
    process.env.XDG_CONFIG_HOME = join(dir, 'xdg');
    const globalDir = join(process.env.XDG_CONFIG_HOME, 'opencode');
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(join(globalDir, 'opencode.json'), readFileSync(configFile));
    const options = parseArgs([]);
    restoreProfileConfig(options, null, { developer: 'coarena-1/claude-fable-5-2' });
    assert.equal(options.profile, 'custom');
    assert.equal(effectiveAgentModels(options).developer, 'coarena-1/claude-fable-5-2');
    assert.equal(saveProfileConfig(options).ok, true);
    assert.equal(profileConfigPath(), join(process.env.XDG_CONFIG_HOME, 'thefactory', 'config.json'));
    assert.equal(loadProfileConfig().profile, 'custom');
    assert.throws(() => restoreProfileConfig(parseArgs(['--profile', 'custom']), null), /No saved Custom profile/);
    const invalid = join(dir, 'invalid.json');
    writeFileSync(invalid, '{broken');
    assert.equal(loadProfileConfig(invalid), null);
    assert.equal(saveProfileConfig({ profile: 'custom' }, invalid).ok, false);
    assert.equal(readFileSync(invalid, 'utf8'), '{broken');
  } finally {
    if (old === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = old;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('quota fallbacks never overwrite the saved Custom lineup', async () => {
  const { dir, configFile, options, path } = setup();
  try {
    customizeModel(options, 'orchestrator', 'coarena-1/claude-opus-5-5', resolvedModelConfig(options, { configFile }));
    assert.equal(saveProfileConfig(options, path).ok, true);
    const saved = readFileSync(path, 'utf8');
    const bin = join(dir, 'fake-opencode');
    writeFileSync(bin, `#!/usr/bin/env node
const args=process.argv.slice(2); const model=args[args.indexOf('-m')+1];
console.log(JSON.stringify(model.startsWith('coarena-')?{type:'error',error:{message:'429 quota exhausted'}}:{type:'text',part:{text:'OK'}}));
`, { mode: 0o700 });
    const result = await launchRunWithFallback({
      task: 'test', bin, model: options.model, agentModels: effectiveAgentModels(options), fallbackModels: ['opencode-go/glm-5.3'],
      env: { COARENA_API_KEY_1: 'test-key' },
    });
    assert.equal(result.result.code, 0);
    assert.equal(result.model, 'opencode-go/glm-5.3');
    assert.equal(readFileSync(path, 'utf8'), saved);
    assert.deepEqual(loadProfileConfig(path).customProfile.agentModels, effectiveAgentModels(options));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
