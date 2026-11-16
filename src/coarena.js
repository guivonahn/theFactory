import { chmodSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { AGENT_ORDER } from './agents.js';
import { baseProfile, globalConfigPath } from './profiles.js';

// Any number of keys is supported: COARENA_API_KEY_1, _2, _3, ... in .env.
const KEY_NAME_PATTERN = /^COARENA_API_KEY_([1-9]\d*)$/;
const MODELS = {
  'claude-opus-5-5': 'Claude Opus 5.5',
  'claude-fable-5-2': 'Claude Fable 5.2',
  'gpt-6-luna': 'GPT-6 Luna',
  'gemini-3-8-flash': 'Gemini 3.8 Flash',
  'deepseek-v4-1-flash-1017': 'DeepSeek V4.1 Flash 1017',
};

/** Coarena key names found in `values`, ordered by slot number. */
function keyNames(values) {
  return Object.keys(values)
    .map((name) => ({ name, slot: KEY_NAME_PATTERN.exec(name)?.[1] }))
    .filter(({ slot }) => slot !== undefined)
    .sort((a, b) => Number(a.slot) - Number(b.slot))
    .map(({ name }) => name);
}

/** Load only Coarena credentials, keeping exported variables authoritative. */
export function loadCoarenaEnv(path = new URL('../.env', import.meta.url), env = process.env) {
  let values;
  try { values = parseEnv(readFileSync(path, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return;
    throw new Error('Cannot read theFactory .env file');
  }
  for (const name of keyNames(values)) {
    if (env[name] === undefined && values[name] !== undefined) env[name] = values[name];
  }
}

export function isCoarenaModel(model) {
  return /^coarena(?:-[1-9]\d*)?\//.test(String(model ?? ''));
}

/** A saved legacy key selection appears as one automatic model choice in the UI. */
export function coarenaModelChoice(model) {
  return isCoarenaModel(model) ? model.replace(/^coarena-[1-9]\d*\//, 'coarena/') : model;
}

export function coarenaModelChoices(env = process.env) {
  return [...new Set(coarenaModels(env).map(coarenaModelChoice))];
}

export function coarenaModels(env = process.env) {
  // Reusing the same key twice does not create a second credential.
  const seen = new Set();
  const slots = keyNames(env).flatMap((name) => {
    const key = env[name]?.trim();
    if (!key || seen.has(key)) return [];
    seen.add(key);
    return [Number(KEY_NAME_PATTERN.exec(name)[1])];
  });
  return Object.keys(MODELS).flatMap((model) => slots.map((slot) => `coarena-${slot}/${model}`));
}

/** Rotate the selected model through keys downward, wrapping to unused higher slots. */
export function automaticFallbackModels(model, available, fallbackModels) {
  if (!isCoarenaModel(model)) return [...new Set([...available, ...fallbackModels])].filter((next) => next !== model);
  const selected = model.split('/')[1].split('#')[0];
  const keySlot = (next) => Number(next.split('/')[0].slice('coarena-'.length));
  const sameModel = available.filter((next) => next.split('/')[1] === selected)
    .sort((a, b) => keySlot(b) - keySlot(a));
  const slot = model.startsWith('coarena/') ? keySlot(sameModel[0] ?? 'coarena-0/')
    : keySlot(model);
  return [...new Set([
    ...sameModel.filter((next) => keySlot(next) < slot),
    ...sameModel.filter((next) => keySlot(next) > slot),
    ...fallbackModels.filter((next) => !isCoarenaModel(next)),
  ])].filter((next) => next !== model);
}

/** Recompute the automatic pool without replacing a user-authored list. */
export function syncModelRouting(options, goModels, env = process.env) {
  const customFree = baseProfile(options) === 'free' && ![options.model, ...Object.values(options.agentModels ?? {})].some(isCoarenaModel);
  const models = options.profile === 'free' || customFree ? [] : coarenaModels(env);
  if (options.profile === 'free' && isCoarenaModel(options.model)) options.model = null;
  if (!options.model && options.profile == null && models.length) options.model = coarenaModelChoice(models[0]);
  if (options.autoFallback) {
    options.fallbackModels = automaticFallbackModels(options.model, models, goModels);
  }
}

export function usesCoarena(options = {}) {
  return options.coarena === true || [options.model, ...Object.values(options.agentModels ?? {}), ...(options.fallbackModels ?? [])].some(isCoarenaModel);
}

/** Global provider policies outrank per-process config; allow only our aliases. */
export function ensureCoarenaPolicy(path = globalConfigPath(), env = process.env) {
  const providers = [...new Set(coarenaModels(env).map((model) => model.split('/')[0]))];
  if (!providers.length) return;
  providers.unshift('coarena');
  const config = JSON.parse(readFileSync(path, 'utf8'));
  const container = config.policies ? config : (config.experimental ??= {});
  const before = container.policies ?? [];
  const after = before.filter((p) => !(p.action === 'provider.use' && providers.includes(p.resource)));
  after.push(...providers.map((resource) => ({ action: 'provider.use', resource, effect: 'allow' })));
  if (JSON.stringify(before) === JSON.stringify(after)) return;
  container.policies = after;
  const temp = `${path}.coarena-${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
}

/** Per-process config: keys stay in the environment; no global config writes. */
export function coarenaRunEnv(env, model, { allAgents = false } = {}) {
  const config = env.OPENCODE_CONFIG_CONTENT ? JSON.parse(env.OPENCODE_CONFIG_CONTENT) : {};
  config.providers ??= {};
  config.experimental ??= {};
  const policies = config.experimental.policies ??= [];
  for (const name of keyNames(env)) {
    if (!env[name]?.trim()) continue;
    const provider = `coarena-${KEY_NAME_PATTERN.exec(name)[1]}`;
    config.providers[provider] = {
      package: '@opencode/ai/providers/anthropic',
      env: [name],
      // OpenCode's runtime appends /messages; Python's Anthropic SDK appends
      // /v1/messages. This runtime therefore needs /v1 in the base URL.
      settings: { apiKey: `{env:${name}}`, baseURL: 'https://coarena.ai/api/v1' },
      models: Object.fromEntries(Object.entries(MODELS).map(([id, name]) => [id, {
        modelID: id,
        name: `${name} (Coarena)`,
        capabilities: { tools: true, input: ['text', 'image'], output: ['text'] },
        limit: { context: 128000, output: 8192 },
      }])),
    };
    policies.push({ action: 'provider.use', resource: provider, effect: 'allow' });
  }
  // The selector uses one provider alias; its credential is chosen per process.
  const preferred = coarenaModels(env).at(-1)?.split('/')[0];
  if (preferred) {
    config.providers.coarena = config.providers[preferred];
    policies.push({ action: 'provider.use', resource: 'coarena', effect: 'allow' });
  }
  if (model) {
    config.model = model;
    config.agents ??= {};
    if (allAgents) {
      for (const agent of ['orchestrator', ...AGENT_ORDER]) {
        config.agents[agent] = { ...config.agents[agent], model };
      }
    }
  }
  return { ...env, OPENCODE_CONFIG_CONTENT: JSON.stringify(config) };
}
