import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { MODEL_AGENT_KEYS, resolvedModelConfig } from './agentModels.js';
import { baseProfile, PROFILE_ORDER, withProfile } from './profiles.js';

export function profileConfigPath() {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'thefactory', 'config.json');
}

function validModel(model) {
  return typeof model === 'string' && /^[^\s/#]+\/[^\s#]+(?:#[^\s#]+)?$/.test(model);
}

function modelMap(models, baseOnly = false) {
  return Object.fromEntries(MODEL_AGENT_KEYS.flatMap((agent) => validModel(models?.[agent])
    ? [[agent, baseOnly ? models[agent].split('#')[0] : models[agent]]] : []));
}

function sanitizeCustom(custom) {
  if (!custom || !validModel(custom.model)) return null;
  const agents = modelMap(custom.agentModels);
  if (Object.keys(agents).length !== MODEL_AGENT_KEYS.length) return null;
  return { baseProfile: PROFILE_ORDER.includes(custom.baseProfile) ? custom.baseProfile : null, model: custom.model, agentModels: agents };
}

export function loadProfileConfig(path = profileConfigPath()) {
  try {
    const saved = JSON.parse(readFileSync(path, 'utf8'));
    if (!saved || saved.version !== 1 || !(saved.profile == null || saved.profile === 'custom' || PROFILE_ORDER.includes(saved.profile))) return null;
    const customProfile = sanitizeCustom(saved.customProfile);
    if (saved.profile === 'custom' && !customProfile) return null;
    return { profile: saved.profile ?? null, model: validModel(saved.model) ? saved.model : null, agentModels: modelMap(saved.agentModels, true), customProfile };
  } catch { return null; }
}

export function saveProfileConfig(options, path = profileConfigPath()) {
  try {
    const customProfile = sanitizeCustom(options.customProfile);
    if (options.profile === 'custom' && !customProfile) throw new Error('Invalid Custom profile');
    const payload = { version: 1, profile: options.profile ?? null, model: validModel(options.model) ? options.model : null, agentModels: modelMap(options.agentModels, true), customProfile };
    mkdirSync(dirname(path), { recursive: true });
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, path);
    return { ok: true };
  } catch { return { ok: false, error: 'Could not save profile configuration' }; }
}

function activateCustom(options) {
  if (!options.customProfile) throw new Error('No saved Custom profile. Edit a model in /config to create one.');
  options.profile = 'custom';
  options.model = options.customProfile.model;
  options.agentModels = modelMap(options.customProfile.agentModels, true);
}

/** CLI profile flags override the saved selection; legacy base choices migrate. */
export function restoreProfileConfig(options, saved, legacyModels = {}) {
  const requestedProfile = options.profile;
  const requestedModel = options.model;
  options.customProfile = saved?.customProfile ?? null;
  if (!saved && Object.keys(legacyModels).length) {
    const legacy = resolvedModelConfig({ ...options, profile: null, model: null, agentModels: legacyModels });
    options.customProfile = { baseProfile: null, model: legacy.model, agentModels: legacy.agentModels };
    if (!options.profileExplicit) options.profile = 'custom';
  }
  options.agentModels = saved ? { ...saved.agentModels } : { ...legacyModels };
  if (saved && !options.profileExplicit) options.profile = saved.profile;
  if (saved && !options.modelExplicit) options.model = saved.model;
  if (options.profileExplicit) { options.profile = requestedProfile; options.agentModels = {}; options.model = null; }
  if (options.profile === 'custom') activateCustom(options);
  if (options.modelExplicit) options.model = requestedModel;
}

/** Start a preset cleanly; keep the saved Custom slot available for later. */
export function selectProfile(options, profile) {
  if (profile === 'custom') { activateCustom(options); return; }
  options.profile = profile;
  options.model = null;
  options.agentModels = {};
}

/** Freeze the current lineup before changing exactly one model. */
export function customizeModel(options, agent, model, resolved = resolvedModelConfig(options)) {
  const origin = baseProfile(options);
  if (options.profile !== 'custom') {
    options.customProfile = { baseProfile: origin, model: resolved.model ?? resolved.agentModels.orchestrator, agentModels: { ...resolved.agentModels } };
  }
  const custom = options.customProfile;
  let next = custom.model;
  if (model) next = model.includes('#') ? model : withProfile(model, origin === 'free' ? null : origin);
  if (agent === 'model') {
    custom.model = next;
    custom.agentModels = Object.fromEntries(MODEL_AGENT_KEYS.map((key) => [key, next]));
  } else {
    custom.agentModels = { ...custom.agentModels, [agent]: next };
  }
  activateCustom(options);
}
