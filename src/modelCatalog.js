/** Public model identifiers only. Never serialize provider config or credentials. */
import { execFileSync } from 'node:child_process';
import { coarenaModelChoice, coarenaModelChoices } from './coarena.js';
import { stripAnsi } from './canvas.js';

export function parseModelCatalog(output) {
  return [...new Set(stripAnsi(String(output)).split(/\r?\n/).map((line) => line.trim())
    .filter((line) => /^[^\s/#]+\/[^\s#]+(?:#[^\s#]+)?$/.test(line)))];
}

export function readModelCatalog({ env = process.env, execute = execFileSync } = {}) {
  const configured = coarenaModelChoices(env);
  try {
    const output = execute(env.FACTORY_OPENCODE || 'opencode', ['models'], {
      env, encoding: 'utf8', timeout: 15000, maxBuffer: 4 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const models = parseModelCatalog(output);
    return {
      version: 1, models: [...new Set([...configured, ...models].map(coarenaModelChoice))],
      error: models.length ? null : 'OpenCode returned no models. Only configured theFactory models are shown.',
    };
  } catch {
    return {
      version: 1, models: configured,
      error: 'Could not load the OpenCode catalog. Check the CLI setup and refresh. Only configured theFactory models are shown.',
    };
  }
}
