/** OpenCode Go usage lookup and polling, kept independent from the renderer. */

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const GO_USAGE_URL = 'https://opencode.ai/zen/go/v1/usage';
export const DEFAULT_OPENCODE_DB_PATH = path.join(os.homedir(), '.local/share/opencode/opencode.db');

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

/** Read only the OpenCode OAuth access token; all failures are non-fatal. */
export function readOpencodeAccessToken(dbPath = process.env.OPENCODE_DB || DEFAULT_OPENCODE_DB_PATH) {
  let db = null;
  try {
    if (!dbPath || !fs.existsSync(dbPath)) return null;
    db = retryBusy(() => new DatabaseSync(dbPath, { readOnly: true }));
    try {
      db.exec('PRAGMA busy_timeout = 2000');
    } catch {
      // The explicit busy retry still covers read-only connections.
    }
    const row = db.prepare("SELECT value FROM credential WHERE integration_id = 'opencode' LIMIT 1").get();
    const value = typeof row?.value === 'string' ? JSON.parse(row.value) : row?.value;
    return typeof value?.access === 'string' && value.access.length > 0 ? value.access : null;
  } catch {
    return null;
  } finally {
    if (db) {
      try { db.close(); } catch {}
    }
  }
}

function normalizeWindow(value) {
  if (!value || typeof value !== 'object') return null;
  if (typeof value.percent !== 'number' || !Number.isFinite(value.percent) || value.percent < 0) return null;
  if (typeof value.resetsAt !== 'string' || value.resetsAt.length === 0) return null;
  return {
    percent: value.percent,
    resetsAt: value.resetsAt,
    status: typeof value.status === 'string' ? value.status : '',
  };
}

/** Fetch and normalize the Go usage response, returning null on any failure. */
export async function fetchGoUsage({ token, fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  if (typeof token !== 'string' || token.trim().length === 0 || typeof fetchImpl !== 'function') return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1, Number(timeoutMs) || 8000));
  timeout.unref?.();
  try {
    const response = await fetchImpl(GO_USAGE_URL, {
      headers: { Authorization: `Bearer ${token.trim()}` },
      signal: controller.signal,
    });
    if (!response?.ok) return null;
    const payload = await response.json();
    const rolling = normalizeWindow(payload?.usage?.rolling);
    if (!rolling) return null;
    return {
      rolling,
      weekly: normalizeWindow(payload?.usage?.weekly),
      monthly: normalizeWindow(payload?.usage?.monthly),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/** Poll immediately and on an interval; late responses cannot update a stopped app. */
export function startGoUsagePoller(app, {
  intervalMs = 60000,
  dbPath = process.env.OPENCODE_DB || DEFAULT_OPENCODE_DB_PATH,
  fetchImpl = fetch,
  timeoutMs = 8000,
} = {}) {
  let stopped = false;
  let inFlight = false;
  const poll = async () => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      const token = readOpencodeAccessToken(dbPath);
      const usage = await fetchGoUsage({ token, fetchImpl, timeoutMs });
      if (!stopped) app.setGoUsage(usage);
    } catch {
      if (!stopped) app.setGoUsage(null);
    } finally {
      inFlight = false;
    }
  };

  void poll();
  const timer = setInterval(() => { void poll(); }, Math.max(1, Number(intervalMs) || 60000));
  timer.unref?.();
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
    },
  };
}

/** Compact duration until an ISO reset timestamp. */
export function formatReset(resetsAt, nowMs = Date.now()) {
  if (typeof resetsAt !== 'string' || resetsAt.trim().length === 0 || !Number.isFinite(nowMs)) return '';
  const resetMs = new Date(resetsAt).getTime();
  if (!Number.isFinite(resetMs)) return '';
  const remaining = resetMs - nowMs;
  if (remaining <= 0) return 'now';
  const minutes = Math.ceil(remaining / 60000);
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return hours > 0 ? `${hours}h${remainder}m` : `${remainder}m`;
}
