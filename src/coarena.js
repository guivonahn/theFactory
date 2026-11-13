import { chmodSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { AGENT_ORDER } from './agents.js';
import { baseProfile, globalConfigPath } from './profiles.js';

const KEY_NAMES = ['COARENA_API_KEY_1', 'COARENA_API_KEY_2'];
const MODELS = ['claude-opus-5-5', 'claude-fable-5-2'];

/** Load only Coarena credentials, keeping exported variables authoritative. */
export function loadCoarenaEnv(path = new URL('../.env', import.meta.url), env = process.env) {
  let values;
  try { values = parseEnv(readFileSync(path, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return;
    throw new Error('Cannot read theFactory .env file');
  }
  for (const name of KEY_NAMES) {
    if (env[name] === undefined && values[name] !== undefined) env[name] = values[name];
  }
}

export function isCoarenaModel(model) {
  return /^coarena-[12]\//.test(String(model ?? ''));
}

export function coarenaModels(env = process.env) {
  // Reusing the same key twice does not create a second credential.
  const seen = new Set();
  const slots = KEY_NAMES.flatMap((name, index) => {
    const key = env[name]?.trim();
    if (!key || seen.has(key)) return [];
    seen.add(key);
    return [index + 1];
  });
  return MODELS.flatMap((model) => slots.map((slot) => `coarena-${slot}/${model}`));
}

/** Recompute the automatic pool without replacing a user-authored list. */
export function syncModelRouting(options, goModels, env = process.env) {
  const customFree = baseProfile(options) === 'free' && ![options.model, ...Object.values(options.agentModels ?? {})].some(isCoarenaModel);
  const models = options.profile === 'free' || customFree ? [] : coarenaModels(env);
  if (options.profile === 'free' && isCoarenaModel(options.model)) options.model = null;
  if (!options.model && options.profile == null && models.length) options.model = models[0];
  if (options.autoFallback) {
    options.fallbackModels = [...new Set([...models, ...goModels])].filter((m) => m !== options.model);
  }
}

export function usesCoarena(options = {}) {
  return options.coarena === true || [options.model, ...Object.values(options.agentModels ?? {}), ...(options.fallbackModels ?? [])].some(isCoarenaModel);
}

/** Global provider policies outrank per-process config; allow only our aliases. */
export function ensureCoarenaPolicy(path = globalConfigPath(), env = process.env) {
  const providers = [...new Set(coarenaModels(env).map((model) => model.split('/')[0]))];
  if (!providers.length) return;
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
  for (const [index, name] of KEY_NAMES.entries()) {
    if (!env[name]?.trim()) continue;
    const provider = `coarena-${index + 1}`;
    config.providers[provider] = {
      package: '@opencode/ai/providers/anthropic',
      env: [name],
      // OpenCode's runtime appends /messages; Python's Anthropic SDK appends
      // /v1/messages. This runtime therefore needs /v1 in the base URL.
      settings: { apiKey: `{env:${name}}`, baseURL: 'https://coarena.ai/api/v1' },
      models: Object.fromEntries(MODELS.map((id) => [id, {
        modelID: id,
        name: id === MODELS[0] ? 'Claude Opus 5.5 (Coarena)' : 'Claude Fable 5.2 (Coarena)',
        capabilities: { tools: true, input: ['text', 'image'], output: ['text'] },
        limit: { context: 128000, output: 8192 },
      }])),
    };
    policies.push({ action: 'provider.use', resource: provider, effect: 'allow' });
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
