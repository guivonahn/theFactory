/**
 * Global verbosity selector. The level is appended to every agent's system
 * prompt behind a fixed marker so it can be replaced or removed idempotently.
 */

import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { globalConfigPath } from './profiles.js';

export const VERBOSITY_ORDER = ['low', 'medium', 'high'];
export const VERBOSITY_MARKER = '\n\n[theFactory verbosity]';

export const VERBOSITY_PROMPTS = {
  low: [
    'LOW — minimize tokens. Answer first. Do not restate the request, narrate routine tool calls, or add optional explanation.',
    'Use the shortest correct form: terse bullets or a single sentence. Omit greetings, plans you already executed, and closing filler.',
  ].join(' '),
  medium: [
    'MEDIUM — stay concise. Use short paragraphs or bullets, give brief rationale only where it changes a decision,',
    'and avoid filler, repetition, and narrating routine tool calls.',
  ].join(' '),
  high: [
    'HIGH — include the essential evidence, reasoning, verification details, and file:line references that justify the result.',
    'Be complete but never repetitive; omit filler and do not restate the request.',
  ].join(' '),
};

/** Remove a previously appended verbosity block, leaving the base prompt intact. */
export function stripVerbosity(system) {
  if (typeof system !== 'string') return system;
  const index = system.lastIndexOf(VERBOSITY_MARKER);
  return index >= 0 ? system.slice(0, index) : system;
}

/**
 * Append (or replace) the verbosity instruction on every agent system prompt.
 * `level` null removes the block. `configFile` is a test override.
 * Returns { ok, agents, applied, error }.
 */
export function applyVerbosityToAllAgents(level, { configFile } = {}) {
  const path = configFile ?? globalConfigPath();
  if (level != null && !VERBOSITY_ORDER.includes(level)) {
    return { ok: false, agents: 0, applied: [], error: `unknown verbosity: ${level}` };
  }

  try {
    if (!existsSync(path)) {
      return { ok: false, agents: 0, applied: [], error: 'opencode.json not found' };
    }
    chmodSync(path, 0o600);
    const config = JSON.parse(readFileSync(path, 'utf8'));
    const applied = [];
    if (config.agents && typeof config.agents === 'object') {
      for (const [agent, definition] of Object.entries(config.agents)) {
        if (!definition || typeof definition !== 'object' || typeof definition.system !== 'string') continue;
        const base = stripVerbosity(definition.system);
        definition.system = level == null
          ? base
          : `${base}${VERBOSITY_MARKER}\n${VERBOSITY_PROMPTS[level]}`;
        applied.push({ agent, level: level ?? null });
      }
    }
    writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
    chmodSync(path, 0o600);
    return { ok: true, agents: applied.length, applied, error: null };
  } catch (error) {
    return { ok: false, agents: 0, applied: [], error: error?.message ?? String(error) };
  }
}
