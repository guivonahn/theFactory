/**
 * Persist the last OpenCode session id across theFactory restarts so a new
 * invocation can resume the same session (when the working directory matches).
 * Zero dependencies; read/write errors are swallowed so a broken state file
 * never blocks the TUI.
 */

import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/** Path of the persisted session file, honouring XDG_STATE_HOME. */
export function persistedSessionPath() {
  const base = process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state');
  return join(base, 'thefactory', 'session.json');
}

function sameDir(a, b) {
  return resolve(String(a)) === resolve(String(b));
}

/**
 * Load the persisted session id, only when its stored directory matches `dir`
 * (or the current working directory when `dir` is omitted).
 * Returns `{ sessionID, dir, updatedAt }` or null.
 */
export function loadPersistedSession({ dir } = {}) {
  try {
    const raw = readFileSync(persistedSessionPath(), 'utf8');
    const data = JSON.parse(raw);
    if (!data || typeof data.sessionID !== 'string' || !data.sessionID) return null;
    const expected = dir ?? process.cwd();
    const storedDir = typeof data.dir === 'string' && data.dir ? data.dir : null;
    if (storedDir && !sameDir(storedDir, expected)) return null;
    if (!storedDir) return null;
    return { sessionID: data.sessionID, dir: storedDir, updatedAt: data.updatedAt ?? null };
  } catch {
    return null;
  }
}

/** Persist the given session id for `dir` (defaults to the cwd). No-op on error. */
export function savePersistedSession({ sessionID, dir } = {}) {
  if (!sessionID || typeof sessionID !== 'string') return;
  try {
    const path = persistedSessionPath();
    mkdirSync(dirname(path), { recursive: true });
    const payload = {
      sessionID,
      dir: dir ?? process.cwd(),
      updatedAt: new Date().toISOString(),
    };
    writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`);
  } catch {
    // Silently ignore: persistence must never break a task run.
  }
}

/** Remove the persisted session file, if present. No-op on error. */
export function clearPersistedSession() {
  try {
    unlinkSync(persistedSessionPath());
  } catch {
    // Missing file / permission error: nothing to do.
  }
}
