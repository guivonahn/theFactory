/**
 * Static agent registry used by layout, rendering and live-session mapping.
 * Colours are hex strings from `src/colors.js` (Apple UIKit terminal theme,
 * truecolor; see `apple_uikit_terminal_cli_design_system.json`).
 */

import { AGENT_COLORS } from './colors.js';

export const ORCHESTRATOR = Object.freeze({
  key: 'orchestrator',
  label: 'ORCHESTRATOR',
  color: AGENT_COLORS.orchestrator,
  glyph: '◆',
  role: 'coordinator',
});

/** The six pillar agents, ordered as they appear around the orchestrator. */
export const AGENTS = Object.freeze([
  Object.freeze({ key: 'explorer', label: 'EXPLORER', color: AGENT_COLORS.explorer, glyph: '◇', role: 'maps the terrain' }),
  Object.freeze({ key: 'architect', label: 'ARCHITECT', color: AGENT_COLORS.architect, glyph: '▦', role: 'designs the shape' }),
  Object.freeze({ key: 'developer', label: 'DEVELOPER', color: AGENT_COLORS.developer, glyph: '▶', role: 'writes the code' }),
  Object.freeze({ key: 'reviewer', label: 'REVIEWER', color: AGENT_COLORS.reviewer, glyph: '◉', role: 'challenges the diff' }),
  Object.freeze({ key: 'security', label: 'SECURITY', color: AGENT_COLORS.security, glyph: '!', role: 'hunts for risk' }),
  Object.freeze({ key: 'tester', label: 'TESTER', color: AGENT_COLORS.tester, glyph: '✓', role: 'proves the behaviour' }),
]);

/** Fallback pillar for agents outside the six known roles (e.g. "build"). */
export const OTHER_AGENT = Object.freeze({
  key: 'other',
  label: 'OTHER',
  color: AGENT_COLORS.other,
  glyph: '?',
  role: 'auxiliary agent',
});

export const AGENT_ORDER = Object.freeze(AGENTS.map((agent) => agent.key));

const BY_KEY = new Map([ORCHESTRATOR, ...AGENTS, OTHER_AGENT].map((agent) => [agent.key, agent]));

/**
 * Normalise an arbitrary session agent name into a registry entry.
 * Unknown names intentionally collapse to the grey "other" box.
 */
export function resolveAgent(name) {
  const key = typeof name === 'string' ? name.trim().toLowerCase() : '';
  if (key === 'orchestrator') return ORCHESTRATOR;
  return BY_KEY.get(key) ?? OTHER_AGENT;
}

/** Return a registry entry by exact key, or undefined. */
export function agentByKey(key) {
  return BY_KEY.get(key);
}
