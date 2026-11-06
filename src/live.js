/**
 * Read-only OpenCode SQLite integration. Only session_v2 and session_message
 * are queried; credential/account tables are never opened or referenced.
 */

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveAgent } from './agents.js';
import { toolDetail } from './run.js';

export const DEFAULT_DB_PATH = path.join(os.homedir(), '.local/share/opencode/opencode.db');

/** Database file, overridable for tests via OPENCODE_DB. */
export function databasePath() {
  return process.env.OPENCODE_DB || DEFAULT_DB_PATH;
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isBusy(error) {
  return /busy|locked/i.test(String(error?.message ?? ''));
}

function retryBusy(fn, attempts = 6) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return fn();
    } catch (error) {
      lastError = error;
      if (!isBusy(error)) throw error;
      sleepSync(60 * (attempt + 1));
    }
  }
  throw lastError;
}

function openDatabase() {
  const file = databasePath();
  if (!fs.existsSync(file)) {
    throw new Error(`OpenCode database not found at ${file}`);
  }
  const db = retryBusy(() => new DatabaseSync(file, { readOnly: true }));
  try {
    db.exec('PRAGMA busy_timeout = 2000');
  } catch {
    // Read-only connections may reject the pragma; the busy retry still covers contention.
  }
  return db;
}

/** Run a function with a read-only connection and always close it. */
export function withDatabase(fn) {
  const db = openDatabase();
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/** Fetch recent root sessions with their direct child counts. */
export function fetchRootSessions(db, options = {}) {
  const limit = Math.max(1, options.limit ?? 30);
  const clauses = ['s.parent_id IS NULL'];
  const params = [];
  if (options.dir) {
    clauses.push('(s.directory = ? OR s.directory LIKE ?)');
    params.push(options.dir, `%${options.dir.replace(/\/+$/, '')}`);
  }
  const sql = `
    SELECT s.id, s.slug, s.title, s.agent, s.directory, s.time_created,
           (SELECT COUNT(*) FROM session_v2 c WHERE c.parent_id = s.id) AS child_count
    FROM session_v2 s
    WHERE ${clauses.join(' AND ')}
    ORDER BY s.time_created DESC
    LIMIT ?`;
  params.push(limit);
  return db.prepare(sql).all(...params);
}

/** Open the database, list root sessions, and close it. */
export function listRootSessions(options = {}) {
  return withDatabase((db) => fetchRootSessions(db, options));
}

function fetchSession(db, id) {
  return db.prepare('SELECT * FROM session_v2 WHERE id = ? LIMIT 1').get(id);
}

/** Resolve --session by id, slug, or id prefix; fall back to the newest root. */
export function resolveRoot(db, options = {}) {
  let row = null;
  if (options.session) {
    const needle = options.session;
    row = fetchSession(db, needle);
    if (!row) {
      row = db.prepare('SELECT * FROM session_v2 WHERE slug = ? ORDER BY time_created DESC LIMIT 1').get(needle);
    }
    if (!row) {
      row = db
        .prepare('SELECT * FROM session_v2 WHERE id LIKE ? ORDER BY time_created DESC LIMIT 1')
        .get(`${needle}%`);
    }
    if (!row) throw new Error(`Session not found: ${needle}`);
  } else {
    row = fetchRootSessions(db, { dir: options.dir, limit: 1 })[0] ?? null;
    if (!row) {
      throw new Error(options.dir ? `No root sessions match --dir ${options.dir}` : 'No root sessions found');
    }
  }

  // If a child id was supplied, climb to its root so the whole crew is shown.
  const seen = new Set();
  while (row?.parent_id && !seen.has(row.parent_id)) {
    seen.add(row.parent_id);
    const parent = fetchSession(db, row.parent_id);
    if (!parent) break;
    row = parent;
  }
  return row;
}

/** Direct child sessions of a root session. */
export function fetchChildren(db, rootId) {
  return db.prepare('SELECT * FROM session_v2 WHERE parent_id = ? ORDER BY time_created ASC').all(rootId);
}

function metaFor(row, isRoot) {
  return {
    id: row.id,
    row,
    isRoot,
    agentKey: isRoot ? 'orchestrator' : resolveAgent(row.agent).key,
  };
}

function latestMessages(db, sessionId, limit) {
  const rows = db
    .prepare(
      `SELECT id, session_id, type, seq, time_created, data
       FROM session_message
       WHERE session_id = ? AND type IN ('user', 'assistant')
       ORDER BY time_created DESC, seq DESC
       LIMIT ?`,
    )
    .all(sessionId, Math.max(1, limit));
  return rows.reverse();
}

function newestCursor(db, sessionId) {
  const row = db
    .prepare(
      `SELECT time_created, seq FROM session_message
       WHERE session_id = ? ORDER BY time_created DESC, seq DESC LIMIT 1`,
    )
    .get(sessionId);
  return { time: Number(row?.time_created ?? 0), seq: Number(row?.seq ?? -1) };
}

function parseData(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function textParts(data) {
  if (!data || typeof data !== 'object') return [];
  if (typeof data.text === 'string') return [data.text];
  if (!Array.isArray(data.content)) return [];
  return data.content.filter((part) => part?.type === 'text' && typeof part.text === 'string').map((part) => part.text);
}

/** Strip the loudest markdown noise and collapse whitespace. */
export function plainText(value) {
  return String(value ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/[*_~]{1,3}/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function tail(value, max = 160) {
  const text = plainText(value);
  if (text.length <= max) return text;
  return `…${text.slice(-max)}`;
}

/** Convert one DB row into zero or more app events. */
export function convertRow(row, meta) {
  const data = parseData(row.data);
  const events = [];
  if (row.type === 'user') {
    const text = tail(textParts(data).join(' '), 160);
    if (!text) return events;
    if (meta.isRoot) {
      events.push({ kind: 'status', from: 'orchestrator', text: `task: ${tail(text, 90)}` });
    } else {
      events.push({ kind: 'msg', from: 'orchestrator', to: meta.agentKey, dir: 'out', text });
    }
    return events;
  }

  if (row.type !== 'assistant') return events;

  const content = Array.isArray(data.content) ? data.content : [];
  if (meta.isRoot) {
    const text = tail(textParts(data).join(' '), 120);
    if (text) events.push({ kind: 'status', from: 'orchestrator', text: `orchestrator: ${text}` });
    const named = String(data.agent ?? '').toLowerCase();
    if (named && named !== 'orchestrator' && resolveAgent(named).key !== 'other') {
      events.push({ kind: 'status', from: named, text: 'done' });
    }
    return events;
  }

  for (const part of content) {
    if (part?.type !== 'tool') continue;
    const state = part.state?.status ? ` (${part.state.status})` : '';
    const detail = toolDetail(part.state?.input ?? part.input ?? {});
    events.push({
      kind: 'tool',
      from: meta.agentKey,
      text: `${part.name ?? 'tool'}${detail ? `: ${detail}` : ''}${state}`,
    });
  }

  const text = tail(textParts(data).join(' '), 160);
  if (text) events.push({ kind: 'msg', from: meta.agentKey, dir: 'in', text });

  if (data.finish === 'stop' || data.finish === 'completed') {
    events.push({ kind: 'status', from: meta.agentKey, text: 'done' });
  }
  return events;
}

function orderedEvents(events) {
  return events
    .sort(
      (a, b) =>
        a.time - b.time ||
        a.seq - b.seq ||
        String(a.sessionId).localeCompare(String(b.sessionId)) ||
        a.sub - b.sub,
    )
    .map((entry) => entry.event);
}

/** Chronological live-data source with backfill and incremental polling. */
export class LiveSource {
  constructor(options = {}) {
    this.options = options;
    this.limit = Math.max(1, options.limit ?? 200);
    this.db = null;
    this.root = null;
    this.sessions = new Map();
    this.cursors = new Map();
  }

  open() {
    this.db = openDatabase();
    try {
      this.root = resolveRoot(this.db, this.options);
      this._loadSessions();
    } catch (error) {
      this.close();
      throw error;
    }
    return this;
  }

  /** Attach to a session discovered after construction, without touching app state. */
  attachToExistingRoot(rootId) {
    if (!this.db) this.db = openDatabase();
    try {
      this.options = { ...this.options, session: rootId };
      this.root = resolveRoot(this.db, { session: rootId });
      this._loadSessions();
    } catch (error) {
      this.close();
      throw error;
    }
    return this;
  }

  _loadSessions() {
    this.sessions.clear();
    this.sessions.set(this.root.id, metaFor(this.root, true));
    for (const child of fetchChildren(this.db, this.root.id)) {
      this.sessions.set(child.id, metaFor(child, false));
    }
  }

  /** Agent pillar counts, including multiple child sessions of the same type. */
  agentCounts() {
    const counts = new Map();
    for (const meta of this.sessions.values()) {
      if (meta.isRoot) continue;
      counts.set(meta.agentKey, (counts.get(meta.agentKey) ?? 0) + 1);
    }
    return counts;
  }

  /** Replay the latest N messages per session in global chronological order. */
  loadBackfill() {
    const entries = [];
    let fallback = 0;
    for (const meta of this.sessions.values()) {
      const rows = latestMessages(this.db, meta.id, this.limit);
      for (const row of rows) {
        for (const [sub, event] of convertRow(row, meta).entries()) {
          entries.push({
            time: Number(row.time_created ?? 0),
            seq: Number(row.seq ?? 0),
            sessionId: meta.id,
            sub: fallback + sub,
            event,
          });
        }
        fallback += 10;
      }
      this.cursors.set(meta.id, newestCursor(this.db, meta.id));
    }
    return orderedEvents(entries);
  }

  _discoverChildren() {
    const discovered = [];
    for (const child of fetchChildren(this.db, this.root.id)) {
      if (this.sessions.has(child.id)) continue;
      const meta = metaFor(child, false);
      this.sessions.set(child.id, meta);
      discovered.push(meta);
    }
    return discovered;
  }

  /** Fetch messages newer than each session cursor. Safe to call once per second. */
  poll() {
    if (!this.db) return [];
    const entries = [];
    const discovered = this._discoverChildren();
    for (const meta of discovered) {
      const rows = latestMessages(this.db, meta.id, this.limit);
      for (const row of rows) {
        for (const [sub, event] of convertRow(row, meta).entries()) {
          entries.push({ time: Number(row.time_created ?? 0), seq: Number(row.seq ?? 0), sessionId: meta.id, sub, event });
        }
      }
      this.cursors.set(meta.id, newestCursor(this.db, meta.id));
    }

    for (const meta of this.sessions.values()) {
      const cursor = this.cursors.get(meta.id) ?? { time: 0, seq: -1 };
      const rows = this.db
        .prepare(
          `SELECT id, session_id, type, seq, time_created, data
           FROM session_message
           WHERE session_id = ? AND type IN ('user', 'assistant')
             AND (time_created > ? OR (time_created = ? AND seq > ?))
           ORDER BY time_created ASC, seq ASC`,
        )
        .all(meta.id, cursor.time, cursor.time, cursor.seq);
      for (const row of rows) {
        for (const [sub, event] of convertRow(row, meta).entries()) {
          entries.push({ time: Number(row.time_created ?? 0), seq: Number(row.seq ?? 0), sessionId: meta.id, sub, event });
        }
        const next = { time: Number(row.time_created ?? 0), seq: Number(row.seq ?? 0) };
        if (next.time > cursor.time || (next.time === cursor.time && next.seq > cursor.seq)) {
          cursor.time = next.time;
          cursor.seq = next.seq;
        }
      }
      this.cursors.set(meta.id, cursor);
    }
    return orderedEvents(entries);
  }

  close() {
    if (!this.db) return;
    try {
      this.db.close();
    } finally {
      this.db = null;
    }
  }
}
