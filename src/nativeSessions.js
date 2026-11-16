/** Read-only observation of native OpenCode subagents; never replay old failures. */
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveAgent } from './agents.js';

function dataOf(row) {
  try { return typeof row?.data === 'string' ? JSON.parse(row.data) : row?.data ?? {}; }
  catch { return {}; }
}

export function sessionOutcome(row) {
  const data = dataOf(row);
  const error = data.error;
  const failed = Boolean(error) || data.finish === 'error' || data.outcome === 'failed';
  const cancelled = /^(?:cancelled|canceled|aborted)$/.test(data.finish ?? data.outcome ?? '');
  const completed = /^(?:stop|completed|success|done)$/.test(data.finish ?? data.outcome ?? '');
  return {
    state: cancelled ? 'cancelled' : failed ? 'blocked' : completed ? 'completed' : row?.type === 'idle' ? 'idle' : 'working',
    error: error?.message ?? error?.data?.message ?? (typeof error === 'string' ? error : failed ? 'Subagent stopped without completing its task' : ''),
    details: error, at: Number(row?.time_created ?? 0), seq: Number(row?.seq ?? -1),
    model: typeof data.model === 'string' ? data.model
      : data.model?.providerID && data.model?.modelID ? `${data.model.providerID}/${data.model.modelID}` : null,
  };
}

export function createNativeSessionMonitor({ path, since = Date.now() } = {}) {
  const file = path ?? process.env.OPENCODE_DB ?? join(homedir(), '.local/share/opencode/opencode.db');
  let db;
  return {
    scan(rootID) {
      if (!rootID || !existsSync(file)) return { failures: [], active: [] };
      try {
        db ??= new DatabaseSync(file, { readOnly: true });
        db.exec('PRAGMA busy_timeout = 25');
        const sessions = db.prepare(`WITH RECURSIVE children(id, depth) AS (
          SELECT id, 1 FROM session_v2 WHERE parent_id = ?
          UNION ALL SELECT s.id, c.depth + 1 FROM session_v2 s JOIN children c ON s.parent_id = c.id WHERE c.depth < 8
        ) SELECT s.id, s.parent_id, s.agent, s.title, s.directory FROM session_v2 s JOIN children c ON s.id = c.id LIMIT 200`).all(rootID);
        const failures = [], active = [];
        for (const session of sessions) {
          const latest = db.prepare(`SELECT type, data, time_created, seq FROM session_message WHERE session_id = ?
            AND type IN ('user', 'assistant', 'idle') ORDER BY time_created DESC, seq DESC LIMIT 1`).get(session.id);
          if (!latest) continue;
          let outcome = sessionOutcome(latest);
          if (outcome.at < since) continue;
          if (outcome.state === 'working') { active.push(session.id); continue; }
          if (outcome.state !== 'blocked') continue;
          // Idle errors sometimes omit the model carried by the assistant row.
          if (!outcome.model) {
            const assistant = db.prepare("SELECT data FROM session_message WHERE session_id = ? AND type = 'assistant' ORDER BY seq DESC LIMIT 1").get(session.id);
            outcome = { ...outcome, model: sessionOutcome(assistant).model };
          }
          const prompt = dataOf(db.prepare("SELECT data FROM session_message WHERE session_id = ? AND type = 'user' ORDER BY seq ASC LIMIT 1").get(session.id));
          const text = prompt.text ?? (prompt.content ?? []).filter((p) => p.type === 'text').map((p) => p.text).join('\n');
          failures.push({ ...session, ...outcome, agent: resolveAgent(session.agent).key, prompt: String(text ?? '').slice(-24000) });
        }
        return { failures, active };
      } catch {
        // An unavailable viewer DB never stops provider execution or changes it.
        return { failures: [], active: [] };
      }
    },
    close() { try { db?.close(); } finally { db = null; } },
  };
}
