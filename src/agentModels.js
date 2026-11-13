import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { AGENT_ORDER } from './agents.js';
import { FREE_AGENT_MODELS, globalConfigPath, withProfile } from './profiles.js';
import { isCoarenaModel } from './coarena.js';

export const MODEL_AGENT_KEYS = ['orchestrator', ...AGENT_ORDER];

export function agentModelsPath() {
  return join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'thefactory', 'agent-models.json');
}

function validModels(models) {
  return Object.fromEntries(MODEL_AGENT_KEYS.flatMap((agent) => {
    const model = models?.[agent];
    return typeof model === 'string' && /^[^\s/#]+\/[^\s#]+$/.test(model) ? [[agent, model]] : [];
  }));
}

export function loadAgentModels(path = agentModelsPath()) {
  try { return validModels(JSON.parse(readFileSync(path, 'utf8'))); }
  catch { return {}; }
}

export function saveAgentModels(models, path = agentModelsPath()) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(validModels(models), null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, path);
    return { ok: true };
  } catch { return { ok: false, error: 'Could not save agent model choices' }; }
}

export function effectiveAgentModels(options = {}) {
  if (options.profile === 'custom') return { ...options.customProfile?.agentModels };
  if (options.profile === 'free') return { ...FREE_AGENT_MODELS };
  return Object.fromEntries(Object.entries(validModels(options.agentModels)).map(([agent, model]) => [agent, withProfile(model, options.profile)]));
}

export function hasAgentModels(options = {}) {
  return Object.keys(options.agentModels ?? {}).length > 0;
}

/** Keep an explicit shared selection in step with the selected profile. */
export function syncProfileModel(options) {
  if (options.profile === 'custom') return;
  if (options.profile === 'free') options.model = null;
  else if (typeof options.model === 'string') options.model = withProfile(options.model, options.profile);
}

/** Resolve the models shown in /config from the same defaults used by OpenCode. */
export function resolvedModelConfig(options = {}, { configFile = globalConfigPath() } = {}) {
  if (options.profile === 'custom' && options.customProfile) return { model: options.customProfile.model, agentModels: { ...options.customProfile.agentModels } };
  if (options.profile === 'free') return { model: FREE_AGENT_MODELS.orchestrator, agentModels: { ...FREE_AGENT_MODELS } };
  let config;
  try { config = JSON.parse(readFileSync(configFile, 'utf8')); }
  catch {
    try { config = JSON.parse(readFileSync(new URL('../config/opencode/opencode.json', import.meta.url), 'utf8')); }
    catch { config = {}; }
  }
  const resolve = (model) => options.profile ? withProfile(model, options.profile) : model;
  const overrides = effectiveAgentModels(options);
  const shared = options.model;
  const sharedAgents = isCoarenaModel(shared) && !hasAgentModels(options);
  const agentModels = Object.fromEntries(MODEL_AGENT_KEYS.flatMap((agent) => {
    const model = overrides[agent] ?? (agent === 'orchestrator' || sharedAgents ? shared : null)
      ?? config.agents?.[agent]?.model ?? config.model;
    return model ? [[agent, resolve(model)]] : [];
  }));
  return { model: resolve(shared ?? config.model) ?? null, agentModels };
}

/** Per-turn overrides keep base choices intact when a retry uses another model. */
export function agentModelsRunEnv(env, model, agentModels, fallbackAttempt = false, activeAgent = 'orchestrator') {
  const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT || '{}');
  config.agents ??= {};
  const models = fallbackAttempt
    ? { ...agentModels, [activeAgent]: model }
    : agentModels;
  for (const [agent, selected] of Object.entries(models ?? {})) {
    if (MODEL_AGENT_KEYS.includes(agent) && selected) config.agents[agent] = { ...config.agents[agent], model: selected };
  }
  if (model) config.model = model;
  return { ...env, OPENCODE_CONFIG_CONTENT: JSON.stringify(config) };
}
