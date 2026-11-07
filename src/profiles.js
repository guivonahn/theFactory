import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const PROFILE_ORDER = ['low', 'medium', 'high', 'free'];
export const PAID_PROFILE_ORDER = ['low', 'medium', 'high'];
export const VARIANT_ORDER = ['none', 'low', 'medium', 'high', 'xhigh', 'max'];

// A free-only profile: every agent must run on an `opencode/*-free` model, so
// no subscription (and no OC-NOLIMIT proxy) is required.
export const FREE_AGENT_MODELS = {
  orchestrator: 'opencode/crouton-alpha-free',
  architect: 'opencode/deepseek-v4.1-flash-free',
  explorer: 'opencode/mimo-v2.6-flash-free',
  developer: 'opencode/flint-40b-free',
  reviewer: 'opencode/beam-free',
  security: 'opencode/nemotron-3.5-super-vl-free',
  tester: 'opencode/nemotron-3.5-lightning-free',
};

// Free-tier fallback pool: ALL free models from OpenCode (opencode provider
// and opencode-go provider). OC-NOLIMIT proxy models are intentionally
// excluded — they require the Bun-based proxy and are not part of the default
// fallback. When auto-fallback is on (free profile), retries cycle through
// every one of these so a rate-limited free model can switch to another free
// model instead of failing or falling back to a paid Go model.
export const FREE_FALLBACK_MODELS = [
  // opencode provider (no proxy needed)
  'opencode/beam-free',
  'opencode/crouton-alpha-free',
  'opencode/deepseek-v4.1-flash-free',
  'opencode/flint-40b-free',
  'opencode/glm-5.3-flash-free',
  'opencode/iceman-free',
  'opencode/mimo-v2.6-flash-free',
  'opencode/nemotron-3.5-lightning-free',
  'opencode/nemotron-3.5-super-vl-free',
  // opencode-go provider (free tier of Go)
  'opencode-go/beam-free',
  'opencode-go/crouton-alpha-free',
  'opencode-go/iceman-contributor-free',
];

const DEFAULT_FREE_MODEL = 'opencode/crouton-alpha-free';

// Declared OpenCode Go variants. Unknown models deliberately have no entry so
// profile changes strip old suffixes and leave their base model id untouched.
export const MODEL_VARIANTS = {
  'glm-5.3': ['low', 'high', 'max'],
  'glm-5.3-flash': ['low', 'high', 'max'],
  'deepseek-v4-pro': ['high', 'max'],
  'kimi-k3.1-pro': ['low', 'high', 'max'],
  'claude-haiku-5-5': ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
  'grok-4.7': ['low', 'medium', 'high', 'xhigh'],
  'mimo-v2.6-flash': [],
};

function baseModel(model) {
  return typeof model === 'string' ? model.split('#', 1)[0] : model;
}

/** Pick an exact variant or the nearest one, preferring lower effort on ties. */
export function pickVariant(model, profile) {
  if (typeof model !== 'string' || !PAID_PROFILE_ORDER.includes(profile)) return null;
  const base = baseModel(model);
  const modelName = base.slice(base.lastIndexOf('/') + 1);
  const variants = MODEL_VARIANTS[base] ?? MODEL_VARIANTS[modelName];
  if (!variants?.length) return null;

  const target = VARIANT_ORDER.indexOf(profile);
  let selected = null;
  let selectedIndex = -1;
  let selectedDistance = Infinity;
  for (const variant of variants) {
    const index = VARIANT_ORDER.indexOf(variant);
    if (index < 0) continue;
    const distance = Math.abs(index - target);
    if (
      distance < selectedDistance
      || (distance === selectedDistance && index < selectedIndex)
    ) {
      selected = variant;
      selectedIndex = index;
      selectedDistance = distance;
    }
  }
  return selected;
}

/** Return a model id with the selected profile applied, or just its base id. */
export function withProfile(model, profile) {
  const base = baseModel(model);
  if (typeof base !== 'string') return base;
  const variant = pickVariant(base, profile);
  return variant ? `${base}#${variant}` : base;
}

/** Global opencode.json path, respecting XDG_CONFIG_HOME. */
export function globalConfigPath() {
  const configDir = process.env.XDG_CONFIG_HOME
    ? join(process.env.XDG_CONFIG_HOME, 'opencode')
    : join(homedir(), '.config', 'opencode');
  return join(configDir, 'opencode.json');
}

function templateConfig() {
  try {
    return JSON.parse(readFileSync(join(PROJECT_DIR, 'config', 'opencode', 'opencode.json'), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Apply a profile to the live global default and every configured agent.
 * `free` pins every agent to an `opencode/*-free` model. A null profile (or a
 * paid level) restores the shipped paid lineup before applying the variant, so
 * leaving the free profile goes back to OpenCode Go. `configFile` is a test
 * override. Returns { ok, agents, applied, error }.
 */
export function applyProfileToAllAgents(profile, { configFile } = {}) {
  const path = configFile ?? globalConfigPath();
  if (profile != null && !PROFILE_ORDER.includes(profile)) {
    return { ok: false, agents: 0, applied: [], error: `unknown profile: ${profile}` };
  }

  try {
    if (!existsSync(path)) {
      return { ok: false, agents: 0, applied: [], error: 'opencode.json not found' };
    }
    chmodSync(path, 0o600);
    const config = JSON.parse(readFileSync(path, 'utf8'));
    const template = templateConfig();
    const free = profile === 'free';

    const baseFor = (name, current) => (
      typeof template?.agents?.[name]?.model === 'string'
        ? template.agents[name].model
        : baseModel(current)
    );

    if (typeof config.model === 'string' || config.model == null) {
      const nextModel = free
        ? FREE_AGENT_MODELS.orchestrator
        : withProfile(
            typeof template?.model === 'string' ? template.model
              : (typeof config.model === 'string' ? baseModel(config.model) : null),
            profile,
          );
      if (nextModel) config.model = nextModel;
      else delete config.model;
    }

    const applied = [];
    if (config.agents && typeof config.agents === 'object') {
      for (const [agent, definition] of Object.entries(config.agents)) {
        if (!definition || typeof definition !== 'object') continue;
        if (typeof definition.model !== 'string') {
          // No model pinned: in free mode pin to a free model instead of leaving
          // a paid Go default; otherwise leave it unset.
          if (free) {
            definition.model = FREE_AGENT_MODELS[agent] ?? DEFAULT_FREE_MODEL;
            applied.push({ agent, model: definition.model });
          }
          continue;
        }
        definition.model = free
          ? (FREE_AGENT_MODELS[agent] ?? (baseModel(definition.model)?.endsWith('-free') ? baseModel(definition.model) : DEFAULT_FREE_MODEL))
          : withProfile(baseFor(agent, definition.model), profile);
        applied.push({ agent, model: definition.model });
      }
    }
    if (free && (typeof config.model !== 'string' || !String(config.model).endsWith('-free'))) {
      config.model = FREE_AGENT_MODELS.orchestrator;
    }
    writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
    chmodSync(path, 0o600);
    return { ok: true, agents: applied.length, applied, error: null };
  } catch (error) {
    return { ok: false, agents: 0, applied: [], error: error?.message ?? String(error) };
  }
}
