import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { coarenaModels, coarenaRunEnv, ensureCoarenaPolicy, loadCoarenaEnv, syncModelRouting } from '../src/coarena.js';
import { launchRunWithFallback } from '../src/run.js';
import { createWorkerManager } from '../src/worker.js';
import { GO_MODEL_IDS, parseArgs } from '../src/main.js';
import { FREE_FALLBACK_MODELS } from '../src/profiles.js';

const keys = { COARENA_API_KEY_1: 'test-key-one', COARENA_API_KEY_2: 'test-key-two' };
const expected = [
  'coarena-1/claude-opus-5-5', 'coarena-2/claude-opus-5-5',
  'coarena-1/claude-fable-5-2', 'coarena-2/claude-fable-5-2',
];

test('available credentials precede Go, with no empty or duplicate key attempts', () => {
  assert.deepEqual(coarenaModels(keys), expected);
  assert.deepEqual(coarenaModels({}), []);
  assert.deepEqual(coarenaModels({ COARENA_API_KEY_2: 'two' }), [expected[1], expected[3]]);
  assert.deepEqual(coarenaModels({ COARENA_API_KEY_1: 'same', COARENA_API_KEY_2: 'same' }), [expected[0], expected[2]]);
  const options = { model: null, autoFallback: true };
  syncModelRouting(options, GO_MODEL_IDS, keys);
  assert.equal(options.model, expected[0]);
  assert.deepEqual(options.fallbackModels, [...expected.slice(1), ...GO_MODEL_IDS]);
  const explicit = { model: 'custom/model', autoFallback: false, fallbackModels: ['custom/backup'] };
  syncModelRouting(explicit, GO_MODEL_IDS, keys);
  assert.equal(explicit.model, 'custom/model');
  assert.deepEqual(explicit.fallbackModels, ['custom/backup']);
  options.profile = 'free';
  syncModelRouting(options, FREE_FALLBACK_MODELS, keys);
  assert.equal(options.model, null);
  assert.deepEqual(options.fallbackModels, FREE_FALLBACK_MODELS);
  assert.equal(parseArgs(['--fallback-models', 'a/b']).autoFallback, false);
});

test('.env loads only Coarena keys and does not override exports or leak values into config', () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-env-'));
  try {
    const path = join(dir, '.env');
    writeFileSync(path, 'COARENA_API_KEY_1="from-file"\nCOARENA_API_KEY_2=second\nUNRELATED=ignored\n');
    const env = { COARENA_API_KEY_1: 'exported' };
    loadCoarenaEnv(path, env);
    assert.deepEqual(env, { COARENA_API_KEY_1: 'exported', COARENA_API_KEY_2: 'second' });
    const existing = { permissions: [{ action: 'shell', resource: '*', effect: 'deny' }], agents: { developer: { system: 'keep me' } } };
    const result = coarenaRunEnv({ ...keys, OPENCODE_CONFIG_CONTENT: JSON.stringify(existing) }, expected[0], { allAgents: true });
    assert.ok(!result.OPENCODE_CONFIG_CONTENT.includes(keys.COARENA_API_KEY_1));
    assert.ok(!result.OPENCODE_CONFIG_CONTENT.includes(keys.COARENA_API_KEY_2));
    const config = JSON.parse(result.OPENCODE_CONFIG_CONTENT);
    assert.deepEqual(config.permissions, existing.permissions);
    assert.equal(config.agents.developer.system, 'keep me');
    assert.equal(Object.keys(config.agents).length, 7);
    assert.ok(Object.values(config.agents).every((agent) => agent.model === expected[0]));
    assert.equal(config.providers['coarena-1'].settings.baseURL, 'https://coarena.ai/api/v1');
    assert.equal(config.providers['coarena-2'].settings.apiKey, '{env:COARENA_API_KEY_2}');
    assert.equal(config.experimental.policies.length, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Coarena availability does not replace a preset or its individual models', () => {
  for (const profile of ['low', 'medium', 'high']) {
    const options = { profile, model: null, autoFallback: true };
    syncModelRouting(options, GO_MODEL_IDS, keys);
    assert.equal(options.model, null, `${profile} retains its own default`);
    assert.ok(options.fallbackModels.includes(expected[0]));
  }
  const agents = { orchestrator: { model: 'opencode-go/glm-5.3#high' }, developer: { model: 'opencode-go/kimi-k3.1-pro#high' } };
  const env = coarenaRunEnv({ ...keys, OPENCODE_CONFIG_CONTENT: JSON.stringify({ agents }) }, 'opencode-go/glm-5.3#high');
  assert.deepEqual(JSON.parse(env.OPENCODE_CONFIG_CONTENT).agents, agents);
});

test('global provider policy allows Coarena after broad deny and preserves other config', () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-policy-'));
  try {
    const path = join(dir, 'opencode.json');
    const existing = { model: 'opencode-go/glm-5.3', agents: { developer: { system: 'preserve' } }, experimental: { policies: [
      { action: 'provider.use', resource: '*', effect: 'deny' },
      { action: 'provider.use', resource: 'opencode-go', effect: 'allow' },
    ] } };
    writeFileSync(path, JSON.stringify(existing));
    ensureCoarenaPolicy(path, keys);
    const saved = readFileSync(path, 'utf8');
    const config = JSON.parse(saved);
    assert.deepEqual(config.agents, existing.agents);
    assert.equal(config.model, existing.model);
    assert.deepEqual(config.experimental.policies.slice(0, 2), existing.experimental.policies);
    assert.deepEqual(config.experimental.policies.slice(2).map((p) => p.resource), ['coarena-1', 'coarena-2']);
    ensureCoarenaPolicy(path, keys);
    assert.equal(readFileSync(path, 'utf8'), saved);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

function fakeCli(dir) {
  const path = join(dir, 'opencode');
  writeFileSync(path, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const model = args[args.indexOf('-m') + 1];
const overlay = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || '{}');
fs.appendFileSync(process.env.FACTORY_TEST_CALLS, JSON.stringify({ args, model, overlay }) + '\\n');
if (process.env.FACTORY_TEST_ERROR === 'permanent') {
  console.log(JSON.stringify({type:'error', error:{message:'401 invalid API key'}}));
} else if (model.startsWith('coarena-')) {
  console.log(JSON.stringify({type:'error',sessionID:'session-from-first-attempt',error:{message:'429 insufficient_quota: Daily free limit reached'}}));
} else {
  console.log(JSON.stringify({type:'text',part:{text:'Explained rate limits and quota successfully'}}));
}
`, { mode: 0o700 });
  return path;
}

test('quota failures try both keys and Fable, continue the session on Go, and stop after success', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-fallback-'));
  try {
    const callsFile = join(dir, 'calls.jsonl');
    const pool = [...expected, GO_MODEL_IDS[0], GO_MODEL_IDS[1]];
    const retries = [];
    const result = await launchRunWithFallback({
      bin: fakeCli(dir), task: 'hello', model: pool[0], fallbackModels: pool.slice(1),
      env: { ...keys, FACTORY_TEST_CALLS: callsFile }, onRetry: (model) => retries.push(model),
    });
    assert.equal(result.result.code, 0);
    assert.equal(result.model, GO_MODEL_IDS[0]);
    assert.equal(result.exhausted, false);
    const calls = readFileSync(callsFile, 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(calls.map((call) => call.model), pool.slice(0, 5));
    assert.deepEqual(retries, pool.slice(1, 5));
    for (const call of calls) {
      assert.ok(call.args.includes('--standalone'));
      assert.ok(Object.values(call.overlay.agents).every((agent) => agent.model === call.model));
    }
    for (const call of calls.slice(1)) {
      assert.equal(call.args[call.args.indexOf('--session') + 1], 'session-from-first-attempt');
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('permanent authentication errors stop instead of falling through the pool', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-auth-'));
  try {
    const callsFile = join(dir, 'calls.jsonl');
    const result = await launchRunWithFallback({
      bin: fakeCli(dir), task: 'hello', model: expected[0], fallbackModels: expected.slice(1),
      env: { ...keys, FACTORY_TEST_CALLS: callsFile, FACTORY_TEST_ERROR: 'permanent' },
    });
    assert.equal(result.result.code, 1);
    assert.equal(readFileSync(callsFile, 'utf8').trim().split('\n').length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('cancelling during quota backoff prevents the next attempt', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-abort-'));
  try {
    const callsFile = join(dir, 'calls.jsonl');
    let handle;
    await launchRunWithFallback({
      bin: fakeCli(dir), task: 'hello', model: expected[0], fallbackModels: expected.slice(1),
      env: { ...keys, FACTORY_TEST_CALLS: callsFile },
      onHandle: (value) => { handle = value; }, onRetry: () => handle.kill('SIGTERM'),
    });
    assert.equal(readFileSync(callsFile, 'utf8').trim().split('\n').length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('exhausting both credentials returns a failure even when the CLI exits zero', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-exhausted-'));
  try {
    const callsFile = join(dir, 'calls.jsonl');
    const result = await launchRunWithFallback({
      bin: fakeCli(dir), task: 'hello', model: expected[0], fallbackModels: [expected[1]],
      env: { ...keys, FACTORY_TEST_CALLS: callsFile },
    });
    assert.equal(result.exhausted, true);
    assert.equal(result.result.code, 1);
    assert.equal(readFileSync(callsFile, 'utf8').trim().split('\n').length, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('parallel workers start on the primary before consuming any fallbacks', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-workers-'));
  const previous = process.env.FACTORY_TEST_CALLS;
  try {
    process.env.FACTORY_TEST_CALLS = join(dir, 'calls.jsonl');
    const manager = createWorkerManager({ model: expected[0], fallbackModels: [GO_MODEL_IDS[0]] });
    const bin = fakeCli(dir);
    const first = manager.start({ task: { id: 'a', agent: 'explorer' }, bin });
    const second = manager.start({ task: { id: 'b', agent: 'reviewer' }, bin });
    assert.equal(first.record.model, expected[0]);
    assert.equal(second.record.model, expected[0]);
    assert.ok(first.record.handle, 'first attempt can be cancelled immediately');
    await Promise.all([first.done, second.done]);
    assert.equal(first.record.state, 'completed');
    assert.equal(second.record.state, 'completed');
    assert.equal(first.record.model, GO_MODEL_IDS[0]);
    assert.equal(first.record.error, null);
  } finally {
    if (previous === undefined) delete process.env.FACTORY_TEST_CALLS;
    else process.env.FACTORY_TEST_CALLS = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
