/**
 * Persistence + lifecycle (Phase 6): run/DAG/worker mappings, events, results,
 * attempts, timestamps. Bounded exponential backoff with jitter. Zero deps.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export function parallelStatePath(rootDir) {
  return join(rootDir, 'parallel-state.json');
}

/** Persist a snapshot (plain object). Scoped file — never touches global creds. */
export function saveParallelState(rootDir, snapshot) {
  mkdirSync(rootDir, { recursive: true });
  const data = { ...snapshot, savedAt: new Date().toISOString() };
  writeFileSync(parallelStatePath(rootDir), `${JSON.stringify(data, null, 2)}\n`);
  return data;
}

export function loadParallelState(rootDir) {
  const path = parallelStatePath(rootDir);
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

/**
 * Reconcile persisted snapshot with live worker liveness.
 * Marks interrupted work as interrupted (never completed), keeps results.
 * liveWorkers: Set of live workerIds (or empty when process restarted).
 */
export function reconcile(saved, liveWorkerIds = new Set()) {
  if (!saved) return { reconciled: [], interrupted: [] };
  const reconciled = [];
  const interrupted = [];
  for (const w of saved.workers ?? []) {
    if (['running', 'queued'].includes(w.state) && !liveWorkerIds.has(w.workerId)) {
      reconciled.push({ ...w, state: 'interrupted' });
      interrupted.push(w.workerId);
    } else reconciled.push(w);
  }
  return { reconciled, interrupted, tasks: saved.tasks ?? [], events: saved.events ?? [] };
}

/**
 * Plan a safe resume from saved state (no blind rerun of non-idempotent work).
 * Only tasks that were interrupted/pending/ready AND are idempotent-safe
 * (read-only or explicitly resumable) are listed for re-dispatch.
 * Completed/failed/cancelled are never rerun. Returns { resumable, needsReview }.
 */
export function resumePlan(saved, liveWorkerIds = new Set()) {
  const { reconciled, interrupted } = reconcile(saved, liveWorkerIds);
  const resumable = [];
  const needsReview = [];
  for (const task of saved?.tasks ?? []) {
    const state = task.state ?? 'pending';
    if (['completed', 'failed', 'cancelled', 'blocked'].includes(state)) continue;
    // Interrupted, pending, ready are candidates; only read-only (or explicitly
    // marked idempotent) auto-resume. Write tasks go to needsReview.
    if (task.readOnly === true || task.idempotent === true) {
      resumable.push({ taskId: task.id, reason: state === 'pending' || state === 'ready' ? 'pending' : 'interrupted' });
    } else {
      needsReview.push({ taskId: task.id, reason: state, note: 'write task — confirm before rerun' });
    }
  }
  return { resumable, needsReview, interrupted };
}

/** Bounded exponential backoff with jitter. Capped — never infinite. */
export function backoffMs({ attempt = 1, baseMs = 250, capMs = 5000, rand = Math.random } = {}) {
  const exp = Math.min(capMs, baseMs * 2 ** (Math.max(0, attempt - 1)));
  const jitter = Math.floor(rand() * Math.max(1, Math.floor(exp * 0.25)));
  return Math.min(capMs, exp + jitter);
}

export function isTransientError(message) {
  return /rate limit|quota|429|503|temporar|timeout|timed out|econnreset|econnrefused|etimedout/i.test(String(message ?? ''));
}
