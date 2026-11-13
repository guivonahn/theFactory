/**
 * Deterministic DAG scheduler for theFactory parallel engine (Phase 2).
 * Pure state machine + validator; no I/O, no timers. Workers are attached
 * by the caller via runTasks()/manual dispatch. Zero dependencies.
 *
 * Task input (additive, backward-compatible with plain {id, deps?}):
 *   { id, title?, agent?, deps?: string[], priority?: number,
 *     readOnly?: boolean, files?: string[], acceptance?: string }
 * Scheduler states: pending → ready → running → completed|failed|blocked|cancelled
 */

function clean(value) { return String(value ?? '').trim(); }

export function validateTasks(tasks) {
  if (!Array.isArray(tasks)) throw new Error('tasks must be an array');
  const ids = new Set();
  const normalized = tasks.map((task, index) => {
    const id = clean(task?.id);
    if (!id) throw new Error(`task[${index}] missing id`);
    if (ids.has(id)) throw new Error(`duplicate task id: ${id}`);
    ids.add(id);
    const deps = Array.isArray(task?.deps) ? task.deps.map(clean) : [];
    if (deps.some((d) => !d)) throw new Error(`task ${id} has empty dep`);
    return {
      id,
      title: clean(task.title) || id,
      agent: clean(task.agent) || 'orchestrator',
      deps,
      priority: Number.isFinite(task.priority) ? Number(task.priority) : 0,
      readOnly: typeof task.readOnly === 'boolean' ? task.readOnly : clean(task.agent) !== 'developer',
      files: Array.isArray(task.files) ? [...new Set(task.files.map(normalizeScope).filter(Boolean))] : [],
      acceptance: clean(task.acceptance),
      order: index,
    };
  });
  for (const task of normalized) {
    for (const dep of task.deps) {
      if (!ids.has(dep)) throw new Error(`task ${task.id} missing dependency: ${dep}`);
      if (dep === task.id) throw new Error(`task ${task.id} depends on itself`);
    }
  }
  // Cycle detection (DFS, deterministic order).
  const state = new Map(); // 0 unvisited, 1 visiting, 2 done
  const visit = (id) => {
    const s = state.get(id) ?? 0;
    if (s === 1) throw new Error(`dependency cycle involving ${id}`);
    if (s === 2) return;
    state.set(id, 1);
    const task = normalized.find((t) => t.id === id);
    for (const dep of task.deps) visit(dep);
    state.set(id, 2);
  };
  for (const task of normalized) visit(task.id);
  return normalized;
}

export function createScheduler(options = {}) {
  const maxConcurrency = options.maxConcurrency ?? 3;
  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
    throw new Error('maxConcurrency must be a positive integer');
  }
  const maxRetries = options.maxRetries ?? 0;
  if (!Number.isInteger(maxRetries) || maxRetries < 0) {
    throw new Error('maxRetries must be a non-negative integer');
  }
  const sequential = options.sequential === true;
  const effectiveConcurrency = sequential ? 1 : maxConcurrency;

  let tasksById = new Map();
  let listeners = [];

  const emit = (event) => { for (const fn of listeners) { try { fn(event); } catch {} } };
  const dependentsOf = (id) => [...tasksById.values()].filter((t) => t.deps.includes(id));

  function submit(tasks) {
    const normalized = validateTasks(tasks);
    // Reject overlapping resubmission: ids must be new.
    for (const task of normalized) {
      if (tasksById.has(task.id)) throw new Error(`duplicate task id: ${task.id}`);
    }
    for (const task of normalized) {
      tasksById.set(task.id, {
        ...task,
        state: task.deps.length === 0 ? 'ready' : 'pending',
        attempts: 0,
        error: null,
        result: null,
      });
    }
    emit({ kind: 'submitted', count: normalized.length });
    return api;
  }

  function refreshReady() {
    for (const task of tasksById.values()) {
      if (task.state !== 'pending') continue;
      const depStates = task.deps.map((d) => tasksById.get(d)?.state);
      if (depStates.some((s) => s === 'failed' || s === 'blocked' || s === 'cancelled')) {
        task.state = 'blocked';
        task.error = `Unsuccessful dependency: ${task.deps.filter((id) => ['failed', 'blocked', 'cancelled'].includes(tasksById.get(id)?.state)).join(', ')}`;
        emit({ kind: 'blocked', taskId: task.id, error: task.error });
        refreshReady(); // propagate downstream deterministically
        return;
      }
      if (depStates.every((s) => s === 'completed')) {
        task.state = 'ready';
        emit({ kind: 'ready', taskId: task.id });
      }
    }
  }

  function readyTasks() {
    return [...tasksById.values()]
      .filter((t) => t.state === 'ready')
      .sort((a, b) => (b.priority - a.priority) || (a.order - b.order));
  }

  function nextReady() {
    const running = [...tasksById.values()].filter((t) => t.state === 'running');
    if (running.length >= effectiveConcurrency) return null;
    return readyTasks().find((task) => running.every((other) => !scopesConflict(task, other))) ?? null;
  }

  function dispatchNext() {
    const next = nextReady();
    if (!next) return null;
    next.state = 'running';
    next.attempts += 1;
    emit({ kind: 'dispatched', taskId: next.id, attempts: next.attempts });
    return next;
  }

  function markComplete(id, result) {
    const task = tasksById.get(id);
    if (!task || task.state !== 'running') throw new Error(`cannot complete ${id}: not running`);
    task.state = 'completed';
    task.result = result ?? null;
    emit({ kind: 'completed', taskId: id });
    refreshReady();
    return task;
  }

  function markFailed(id, error) {
    const task = tasksById.get(id);
    if (!task || task.state !== 'running') throw new Error(`cannot fail ${id}: not running`);
    if (task.attempts <= maxRetries) {
      task.state = 'ready';
      task.error = String(error?.message ?? error ?? 'failed');
      emit({ kind: 'retry-ready', taskId: id, attempts: task.attempts, error: task.error });
    } else {
      task.state = 'failed';
      task.error = String(error?.message ?? error ?? 'failed');
      emit({ kind: 'failed', taskId: id, error: task.error });
      refreshReady();
    }
    return task;
  }

  function cancel(id) {
    const task = tasksById.get(id);
    if (!task) throw new Error(`cannot cancel ${id}: unknown`);
    if (!['pending', 'ready', 'blocked'].includes(task.state)) {
      throw new Error(`cannot cancel ${id}: ${task.state}`);
    }
    task.state = 'cancelled';
    emit({ kind: 'cancelled', taskId: id });
    refreshReady();
    return task;
  }

  function markCancelled(id) {
    const task = tasksById.get(id);
    if (!task || task.state !== 'running') throw new Error(`cannot cancel ${id}: not running`);
    task.state = 'cancelled';
    emit({ kind: 'cancelled', taskId: id });
    refreshReady();
    return task;
  }

  function snapshot() {
    return [...tasksById.values()].map((t) => ({ id: t.id, state: t.state, attempts: t.attempts, ...(t.error ? { error: t.error } : {}) }));
  }

  function isDone() {
    const terminal = new Set(['completed', 'failed', 'blocked', 'cancelled']);
    return [...tasksById.values()].every((t) => terminal.has(t.state));
  }

  function onEvent(fn) { if (typeof fn === 'function') listeners.push(fn); return api; }

  const api = { submit, dispatchNext, nextReady, readyTasks, markComplete, markFailed, markCancelled, cancel, snapshot, isDone, onEvent };
  return api;
}

/**
 * Execute tasks with bounded concurrency. `executor(task)` is async.
 * Respects DAG order, honors concurrency, no duplicate dispatch.
 * Sequential option forces concurrency 1.
 */
export async function runTasks({ tasks, executor, concurrency = 3, sequential = false, maxRetries = 0, signal, onEvent } = {}) {
  if (typeof executor !== 'function') throw new Error('executor is required');
  const scheduler = createScheduler({ maxConcurrency: concurrency, maxRetries, sequential });
  if (typeof onEvent === 'function') scheduler.onEvent((event) => onEvent(event, scheduler.snapshot()));
  scheduler.submit(tasks);
  const results = new Map();
  const inflight = new Set();

  const cancelPending = () => {
    for (const task of scheduler.snapshot()) if (task.state === 'pending' || task.state === 'ready') scheduler.cancel(task.id);
  };
  let pump = () => {
    if (signal?.aborted) { cancelPending(); return; }
    while (!scheduler.isDone() && inflight.size < (sequential ? 1 : concurrency)) {
      const next = scheduler.dispatchNext();
      if (!next) break;
      // Queue execution after registration, including executors that throw synchronously.
      const run = Promise.resolve().then(() => {
        if (signal?.aborted) throw new Error('cancelled');
        const dependencies = Object.fromEntries(next.deps.map((id) => [id, results.get(id)]));
        return executor(next, { signal, dependencies });
      }).then((result) => {
        results.set(next.id, result);
        if (signal?.aborted) scheduler.markCancelled(next.id);
        else scheduler.markComplete(next.id, result);
      }).catch((error) => {
        if (signal?.aborted) scheduler.markCancelled(next.id);
        else scheduler.markFailed(next.id, error);
        if (!results.has(next.id)) results.set(next.id, { error: String(error?.message ?? error ?? 'failed') });
      }).finally(() => {
        inflight.delete(run);
        pump();
      });
      inflight.add(run);
    }
  };

  return new Promise((resolve) => {
    let settled = false;
    const check = () => {
      if (settled) return;
      if (scheduler.isDone() && inflight.size === 0) {
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        resolve({ results: Object.fromEntries(results), snapshot: scheduler.snapshot() });
      }
    };
    scheduler.onEvent(check);
    const onAbort = () => { cancelPending(); check(); };
    signal?.addEventListener('abort', onAbort, { once: true });
    // Wrap pump so every completion path re-checks after inflight shrinks.
    const origPump = pump;
    pump = () => { origPump(); check(); };
    pump();
    // Cover the empty / all-sync case.
    check();
  });
}

function normalizeScope(value) {
  const parts = clean(value).replace(/\\/g, '/').replace(/^\.\//, '').split('/');
  const normalized = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') { if (normalized.length) normalized.pop(); else return '*'; }
    else normalized.push(part);
  }
  return normalized.join('/') || '*';
}

/** Readers can overlap; writers acquire only their declared file/directory scopes. */
export function scopesConflict(a, b) {
  if (a.readOnly && b.readOnly) return false;
  if (!a.files?.length || !b.files?.length) return true;
  return a.files.some((left) => b.files.some((right) => {
    const l = normalizeScope(left), r = normalizeScope(right);
    if (/[?*\[]/.test(l) || /[?*\[]/.test(r)) return true;
    return l === r || l.startsWith(`${r}/`) || r.startsWith(`${l}/`);
  }));
}
