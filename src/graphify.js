import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** Compact prompt guide for a graph that has already been prepared. */
export function graphifyPrompt(dir) {
  const graphPath = join(dir, 'graphify-out', 'graph.json');
  return `Code graph: ${graphPath} exists. Prefer graphify query "...", graphify path "A" "B", and graphify explain "X" over reading many files.`;
}

export function withGraphifyPrompt(task, dir) {
  return `${graphifyPrompt(dir)}\n\n${task}`;
}

/** Ensure a project graph exists; all failures are non-fatal return values. */
export function ensureGraphify(dir, { bin = 'graphify', timeout = 60000, graphExists = false } = {}) {
  let graphPath;
  try {
    graphPath = join(dir, 'graphify-out', 'graph.json');
    const alreadyExists = typeof graphExists === 'function'
      ? Boolean(graphExists(graphPath))
      : Boolean(graphExists) || existsSync(graphPath);
    if (alreadyExists) return { ok: true, built: false, graphPath };

    const result = spawnSync(bin, ['update', dir], {
      encoding: 'utf8',
      shell: false,
      timeout,
    });
    if (result.error) {
      return {
        ok: false,
        built: true,
        graphPath,
        error: result.error.message ?? String(result.error),
      };
    }
    if (result.status !== 0) {
      const stderr = String(result.stderr ?? '').trim();
      const stdout = String(result.stdout ?? '').trim();
      const detail = result.status == null
        ? `graphify update terminated${result.signal ? ` by ${result.signal}` : ''}`
        : `graphify update exited with code ${result.status}`;
      return { ok: false, built: true, graphPath, error: stderr || stdout || detail };
    }
    return { ok: true, built: true, graphPath, error: null };
  } catch (error) {
    return {
      ok: false,
      built: false,
      graphPath,
      error: error?.message ?? String(error),
    };
  }
}
