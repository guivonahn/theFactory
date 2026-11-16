import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { automaticFallbackModels, coarenaModelChoices, coarenaModels, coarenaRunEnv, ensureCoarenaPolicy, loadCoarenaEnv, syncModelRouting } from '../src/coarena.js';
import { isTransientProviderError, launchRunWithFallback } from '../src/run.js';
import { createWorkerManager } from '../src/worker.js';
import { GO_MODEL_IDS, parseArgs } from '../src/main.js';
import { FREE_FALLBACK_MODELS } from '../src/profiles.js';

const keys = { COARENA_API_KEY_1: 'test-key-one', COARENA_API_KEY_2: 'test-key-two' };
const fourKeys = { ...keys, COARENA_API_KEY_3: 'test-key-three', COARENA_API_KEY_4: 'test-key-four' };
const apiUsageLimit = 'You have reached your specified API usage limits. You will regain access on 2026-12-01 at 00:00 UTC.';
const expected = [
  'coarena-1/claude-opus-5-5', 'coarena-2/claude-opus-5-5',
  'coarena-1/claude-fable-5-2', 'coarena-2/claude-fable-5-2',
  'coarena-1/gpt-6-luna', 'coarena-2/gpt-6-luna',
  'coarena-1/gemini-3-8-flash', 'coarena-2/gemini-3-8-flash',
  'coarena-1/deepseek-v4-1-flash-1017', 'coarena-2/deepseek-v4-1-flash-1017',
];

test('available credentials precede Go, with no empty or duplicate key attempts', () => {
  assert.deepEqual(coarenaModels(keys), expected);
  assert.deepEqual(coarenaModels({}), []);
  assert.deepEqual(coarenaModels({ COARENA_API_KEY_2: 'two' }), expected.filter((_, index) => index % 2 === 1));
  assert.deepEqual(coarenaModels({ COARENA_API_KEY_1: 'same', COARENA_API_KEY_2: 'same' }), expected.filter((_, index) => index % 2 === 0));
  const options = { model: null, autoFallback: true };
  syncModelRouting(options, GO_MODEL_IDS, keys);
  assert.equal(options.model, 'coarena/claude-opus-5-5');
  assert.deepEqual(options.fallbackModels, [expected[0], ...GO_MODEL_IDS]);
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
    assert.equal(config.experimental.policies.length, 3);
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
    assert.deepEqual(config.experimental.policies.slice(2).map((p) => p.resource), ['coarena', 'coarena-1', 'coarena-2']);
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
} else if ((model.startsWith('coarena-') || model.startsWith('coarena/')) && model !== process.env.FACTORY_TEST_SUCCESS_MODEL) {
  console.log(JSON.stringify({type:'error',sessionID:'session-from-first-attempt',error:{message:process.env.FACTORY_TEST_ERROR_MESSAGE || '429 insufficient_quota: Daily free limit reached'}}));
} else {
  console.log(JSON.stringify({type:'text',part:{text:'Explained rate limits and quota successfully'}}));
}
`, { mode: 0o700 });
  return path;
}

test('manual fallback lists retain their exact key and model order, then continue the session on Go', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-fallback-'));
  try {
    const callsFile = join(dir, 'calls.jsonl');
    const pool = [...expected.slice(0, 4), GO_MODEL_IDS[0], GO_MODEL_IDS[1]];
    const retries = [];
    const result = await launchRunWithFallback({
      bin: fakeCli(dir), task: 'hello', model: pool[0], fallbackModels: pool.slice(1),
      env: { ...keys, FACTORY_TEST_CALLS: callsFile }, onRetry: (model) => retries.push(model),
    });
    assert.equal(result.result.code, 0);
    assert.equal(result.model, GO_MODEL_IDS[0]);
    assert.equal(result.exhausted, false);
    const calls = readFileSync(callsFile, 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(calls.map((call) => call.model), pool.slice(0, -1));
    assert.deepEqual(retries, pool.slice(1, -1));
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

test('any number of numbered keys becomes a provider slot in order', () => {
  const env = {
    COARENA_API_KEY_1: 'one', COARENA_API_KEY_2: 'two', COARENA_API_KEY_3: 'three',
    COARENA_API_KEY_10: 'ten', UNRELATED_COARENA_API_KEY_0: 'ignored', COARENA_API_KEY_0: 'ignored',
  };
  assert.deepEqual(coarenaModels(env), [
    'coarena-1/claude-opus-5-5', 'coarena-2/claude-opus-5-5', 'coarena-3/claude-opus-5-5', 'coarena-10/claude-opus-5-5',
    'coarena-1/claude-fable-5-2', 'coarena-2/claude-fable-5-2', 'coarena-3/claude-fable-5-2', 'coarena-10/claude-fable-5-2',
    'coarena-1/gpt-6-luna', 'coarena-2/gpt-6-luna', 'coarena-3/gpt-6-luna', 'coarena-10/gpt-6-luna',
    'coarena-1/gemini-3-8-flash', 'coarena-2/gemini-3-8-flash', 'coarena-3/gemini-3-8-flash', 'coarena-10/gemini-3-8-flash',
    'coarena-1/deepseek-v4-1-flash-1017', 'coarena-2/deepseek-v4-1-flash-1017', 'coarena-3/deepseek-v4-1-flash-1017', 'coarena-10/deepseek-v4-1-flash-1017',
  ]);
  const run = coarenaRunEnv(env, 'coarena-3/claude-opus-5-5');
  const config = JSON.parse(run.OPENCODE_CONFIG_CONTENT);
  assert.equal(config.providers['coarena-3'].settings.apiKey, '{env:COARENA_API_KEY_3}');
  assert.equal(config.providers['coarena-10'].settings.apiKey, '{env:COARENA_API_KEY_10}');
  assert.ok(config.providers['coarena-0'] === undefined);
  assert.deepEqual(config.experimental.policies.map((p) => p.resource), ['coarena-1', 'coarena-2', 'coarena-3', 'coarena-10', 'coarena']);
  const options = { model: null, autoFallback: true };
  syncModelRouting(options, GO_MODEL_IDS, env);
  assert.equal(options.model, 'coarena/claude-opus-5-5');
  assert.deepEqual(options.fallbackModels.slice(0, 3), [
    'coarena-3/claude-opus-5-5', 'coarena-2/claude-opus-5-5', 'coarena-1/claude-opus-5-5',
  ]);
  const dir = mkdtempSync(join(tmpdir(), 'factory-slots-'));
  try {
    const path = join(dir, '.env');
    writeFileSync(path, 'COARENA_API_KEY_3=from-file\n');
    const loaded = {};
    loadCoarenaEnv(path, loaded);
    assert.deepEqual(loaded, { COARENA_API_KEY_3: 'from-file' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('automatic key rotation descends, skips missing/duplicate keys, and wraps through unused keys', () => {
  const env = { ...fourKeys, COARENA_API_KEY_3: '', COARENA_API_KEY_5: fourKeys.COARENA_API_KEY_2, COARENA_API_KEY_10: 'ten' };
  const selected = 'coarena-4/claude-fable-5-2';
  const options = { model: selected, autoFallback: true };
  syncModelRouting(options, GO_MODEL_IDS, env);
  assert.deepEqual(options.fallbackModels, [
    'coarena-2/claude-fable-5-2', 'coarena-1/claude-fable-5-2', 'coarena-10/claude-fable-5-2', ...GO_MODEL_IDS,
  ]);
  assert.deepEqual(automaticFallbackModels(selected, coarenaModels({}), GO_MODEL_IDS), GO_MODEL_IDS);
});

test('automatic fallback uses key 4 → 3 → 2 → 1 on the selected model, then Go, for root and individual agents', async () => {
  for (const family of ['claude-fable-5-2', 'claude-opus-5-5']) {
    for (const successSlot of [null, 3]) {
      const dir = mkdtempSync(join(tmpdir(), 'factory-descending-keys-'));
      try {
        const callsFile = join(dir, 'calls.jsonl');
        const model = `coarena-4/${family}`;
        const agentModels = family.includes('fable') ? { orchestrator: GO_MODEL_IDS[1], developer: model } : undefined;
        const original = JSON.stringify(agentModels);
        const options = { model: agentModels?.orchestrator ?? model, agentModels, autoFallback: true };
        syncModelRouting(options, GO_MODEL_IDS, fourKeys);
        const result = await launchRunWithFallback({
          ...options, agent: agentModels ? 'developer' : 'orchestrator', bin: fakeCli(dir), task: 'hello', retryDelayMs: 0,
          env: { ...fourKeys, FACTORY_TEST_CALLS: callsFile, FACTORY_TEST_ERROR_MESSAGE: apiUsageLimit,
            FACTORY_TEST_SUCCESS_MODEL: successSlot ? `coarena-${successSlot}/${family}` : '' },
        });
        const pool = [4, 3, 2, 1].map((slot) => `coarena-${slot}/${family}`);
        const expectedCalls = successSlot ? pool.slice(0, 2) : [...pool, GO_MODEL_IDS[0]];
        const calls = readFileSync(callsFile, 'utf8').trim().split('\n').map(JSON.parse);
        assert.deepEqual(calls.map((call) => call.model), expectedCalls);
        assert.ok(calls.slice(1).every((call) => call.args[call.args.indexOf('--session') + 1] === 'session-from-first-attempt'));
        if (agentModels) {
          assert.ok(calls.every((call) => call.overlay.agents.orchestrator.model === agentModels.orchestrator));
          assert.deepEqual(calls.map((call) => call.overlay.agents.developer.model), expectedCalls);
        }
        assert.equal(JSON.stringify(agentModels), original);
        assert.equal(result.result.code, 0);
        assert.equal(result.model, expectedCalls.at(-1));
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }
  }
});

test('parallel workers rotate all four keys downward before Go without changing saved models', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-worker-key-order-'));
  const env = { ...fourKeys, FACTORY_TEST_CALLS: join(dir, 'calls.jsonl'), FACTORY_TEST_ERROR_MESSAGE: apiUsageLimit };
  const previous = Object.fromEntries(Object.keys(env).map((name) => [name, process.env[name]]));
  try {
    Object.assign(process.env, env);
    const callsFile = join(dir, 'calls.jsonl');
    const model = 'coarena-4/claude-fable-5-2';
    const agentModels = { orchestrator: GO_MODEL_IDS[1], developer: model };
    const manager = createWorkerManager({
      model: agentModels.orchestrator, agentModels, autoFallback: true, fallbackModels: GO_MODEL_IDS, retryDelayMs: 0,
      env: { ...fourKeys, FACTORY_TEST_CALLS: callsFile, FACTORY_TEST_ERROR_MESSAGE: apiUsageLimit },
    });
    const { record, done } = manager.start({ task: { id: 'implementation', agent: 'developer', readOnly: false }, dir, bin: fakeCli(dir) });
    await done;
    const calls = readFileSync(callsFile, 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(calls.map((call) => call.model), [4, 3, 2, 1].map((slot) => `coarena-${slot}/claude-fable-5-2`).concat(GO_MODEL_IDS[0]));
    assert.equal(record.state, 'completed');
    assert.equal(agentModels.developer, model);
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('API usage limit without a status code retries the selected model on each key before Go', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-api-limit-'));
  try {
    const callsFile = join(dir, 'calls.jsonl');
    const retries = [];
    const result = await launchRunWithFallback({
      bin: fakeCli(dir), task: 'hello', model: expected[2], autoFallback: true,
      fallbackModels: [GO_MODEL_IDS[0], GO_MODEL_IDS[1]],
      env: { ...keys, FACTORY_TEST_CALLS: callsFile, FACTORY_TEST_ERROR_MESSAGE: apiUsageLimit },
      onRetry: (model, reason) => { assert.match(reason, /specified API usage limits/); retries.push(model); },
    });
    const calls = readFileSync(callsFile, 'utf8').trim().split('\n').map(JSON.parse);
    const pool = [expected[2], expected[3], GO_MODEL_IDS[0]];
    assert.deepEqual(calls.map((call) => call.model), pool);
    assert.deepEqual(retries, pool.slice(1));
    assert.ok(calls.slice(1).every((call) => call.args[call.args.indexOf('--session') + 1] === 'session-from-first-attempt'));
    assert.equal(result.result.code, 0);
    assert.equal(result.model, GO_MODEL_IDS[0]);
    assert.equal(result.exhausted, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Coarena paid-tier rejection tries the remaining keys before Go', async () => {
  const message = 'Claude Fable 5.2 is not part of the free tier. Free accounts can use GPT-6 Luna, Gemini 3.8 Flash and DeepSeek V4.1 Flash 1017. Add credits to use every model: https://coarena.ai/account/api/billing';
  assert.equal(isTransientProviderError(message), true);
  for (const code of ['payment_required', 'insufficient_balance']) assert.equal(isTransientProviderError(code), true);
  const dir = mkdtempSync(join(tmpdir(), 'factory-paid-tier-'));
  try {
    const callsFile = join(dir, 'calls.jsonl');
    const options = { model: 'coarena-4/claude-fable-5-2', autoFallback: true };
    syncModelRouting(options, GO_MODEL_IDS, fourKeys);
    const result = await launchRunWithFallback({
      ...options, bin: fakeCli(dir), task: 'hello', retryDelayMs: 0,
      env: { ...fourKeys, FACTORY_TEST_CALLS: callsFile, FACTORY_TEST_ERROR_MESSAGE: message },
    });
    const calls = readFileSync(callsFile, 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(calls.map((call) => call.model), [4, 3, 2, 1].map((slot) => `coarena-${slot}/claude-fable-5-2`).concat(GO_MODEL_IDS[0]));
    assert.ok(calls.slice(1).every((call) => call.args[call.args.indexOf('--session') + 1] === 'session-from-first-attempt'));
    assert.equal(result.result.code, 0);
    assert.equal(result.model, GO_MODEL_IDS[0]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('automatic model aliases select the highest distinct populated key and register every model', () => {
  const models = ['claude-opus-5-5', 'claude-fable-5-2', 'gpt-6-luna', 'gemini-3-8-flash', 'deepseek-v4-1-flash-1017'];
  assert.deepEqual(coarenaModelChoices(fourKeys), models.map((model) => `coarena/${model}`));
  assert.deepEqual(coarenaModelChoices({}), []);
  const env = { ...fourKeys, COARENA_API_KEY_5: '', COARENA_API_KEY_10: fourKeys.COARENA_API_KEY_1 };
  const config = JSON.parse(coarenaRunEnv(env, 'coarena/gpt-6-luna').OPENCODE_CONFIG_CONTENT);
  assert.equal(config.providers.coarena.settings.apiKey, '{env:COARENA_API_KEY_4}');
  assert.deepEqual(Object.keys(config.providers.coarena.models), models);
  assert.equal(config.providers.coarena.models['gpt-6-luna'].name, 'GPT-6 Luna (Coarena)');
  assert.ok(!JSON.stringify(config).includes(fourKeys.COARENA_API_KEY_4));
});

test('choosing one model automatically rotates keys 4 → 3 → 2 → 1, then Go, without changing other agents', async () => {
  for (const family of ['gpt-6-luna', 'gemini-3-8-flash', 'deepseek-v4-1-flash-1017']) {
    const dir = mkdtempSync(join(tmpdir(), 'factory-auto-key-model-'));
    try {
      const callsFile = join(dir, 'calls.jsonl');
      const model = `coarena/${family}`;
      const agentModels = { orchestrator: GO_MODEL_IDS[1], developer: model };
      const result = await launchRunWithFallback({
        model: agentModels.orchestrator, agent: 'developer', agentModels, autoFallback: true,
        fallbackModels: GO_MODEL_IDS, bin: fakeCli(dir), task: 'hello', retryDelayMs: 0,
        env: { ...fourKeys, FACTORY_TEST_CALLS: callsFile, FACTORY_TEST_ERROR_MESSAGE: apiUsageLimit },
      });
      const calls = readFileSync(callsFile, 'utf8').trim().split('\n').map(JSON.parse);
      const expectedCalls = [model, ...[3, 2, 1].map((slot) => `coarena-${slot}/${family}`), GO_MODEL_IDS[0]];
      assert.deepEqual(calls.map((call) => call.model), expectedCalls);
      assert.equal(calls[0].overlay.providers.coarena.settings.apiKey, '{env:COARENA_API_KEY_4}');
      assert.ok(calls.every((call) => call.overlay.agents.orchestrator.model === agentModels.orchestrator));
      assert.deepEqual(calls.map((call) => call.overlay.agents.developer.model), expectedCalls);
      assert.equal(agentModels.developer, model);
      assert.equal(result.result.code, 0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});
