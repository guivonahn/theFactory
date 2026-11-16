/** Typed launch requests from the macOS popover. Prompt text is never shell code. */
import fs from 'node:fs';
import { MODEL_AGENT_KEYS } from './agentModels.js';

const choices = (value, allowed, name, fallback) => {
  if (value == null) return fallback;
  if (!allowed.includes(value)) throw new Error(`Invalid menu bar ${name}`);
  return value;
};
const model = (value) => {
  if (!value) return '';
  if (typeof value !== 'string' || !/^[^\s/#]+\/[^\s#]+(?:#[^\s#]+)?$/.test(value)) throw new Error('Model must use provider/model or provider/model#variant');
  return value;
};

export function readMenuLaunchRequest(file) {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > 262_144) throw new Error('Invalid menu bar launch request');
  const request = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (request.version !== 1 || typeof request.prompt !== 'string' || !request.prompt.trim() || request.prompt.includes('\0')) throw new Error('A prompt is required');
  if (typeof request.directory !== 'string' || !fs.statSync(request.directory).isDirectory()) throw new Error('Choose an existing project directory');
  const profile = choices(request.profile, ['saved', 'low', 'medium', 'high', 'free', 'custom'], 'profile', 'saved');
  const verbosity = choices(request.verbosity, ['saved', 'low', 'medium', 'high'], 'verbosity', 'saved');
  const execution = choices(request.execution, ['standard', 'parallel', 'sequential'], 'execution mode', 'standard');
  const workers = request.workers ?? 3;
  if (!Number.isInteger(workers) || workers < 1 || workers > 16) throw new Error('Choose between 1 and 16 parallel workers');
  for (const key of ['auto', 'autoFallback', 'graphify', 'muted']) {
    if (request[key] != null && typeof request[key] !== 'boolean') throw new Error(`Invalid menu bar ${key}`);
  }
  const agentModels = {};
  for (const [key, value] of Object.entries(request.agentModels || {})) {
    if (!MODEL_AGENT_KEYS.includes(key)) throw new Error('Unknown agent in menu bar settings');
    const selected = model(value);
    if (selected) agentModels[key] = selected;
  }
  return {
    menuLaunchID: typeof request.id === 'string' ? request.id.slice(0, 80) : null,
    dir: request.directory, task: request.prompt, start: true, fresh: true, mode: 'task',
    profile: profile === 'saved' ? null : profile, profileExplicit: profile !== 'saved',
    model: model(request.model) || null, modelExplicit: Boolean(request.model),
    verbosity: verbosity === 'saved' ? null : verbosity,
    parallel: execution === 'parallel', sequential: execution === 'sequential', workers,
    auto: request.auto ?? false, autoFallback: request.autoFallback ?? true,
    graphify: request.graphify ?? true, mute: request.muted ?? false, menuAgentModels: agentModels,
  };
}
