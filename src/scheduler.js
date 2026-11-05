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
      readOnly: task.readOnly !== false,
      files: Array.isArray(task.files) ? task.files.map(clean) : [],
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
        emit({ kind: 'blocked', taskId: task.id });
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
    const running = [...tasksById.values()].filter((t) => t.state === 'running').length;
    if (running >= effectiveConcurrency) return null;
    return readyTasks()[0] ?? null;
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

  function snapshot() {
    return [...tasksById.values()].map((t) => ({ id: t.id, state: t.state, attempts: t.attempts }));
  }

  function isDone() {
    const terminal = new Set(['completed', 'failed', 'blocked', 'cancelled']);
    return [...tasksById.values()].every((t) => terminal.has(t.state));
  }

  function onEvent(fn) { if (typeof fn === 'function') listeners.push(fn); return api; }

  const api = { submit, dispatchNext, nextReady, readyTasks, markComplete, markFailed, cancel, snapshot, isDone, onEvent };
  return api;
}

/**
 * Execute tasks with bounded concurrency. `executor(task)` is async.
 * Respects DAG order, honors concurrency, no duplicate dispatch.
 * Sequential option forces concurrency 1.
 */
export async function runTasks({ tasks, executor, concurrency = 3, sequential = false, maxRetries = 0 } = {}) {
  if (typeof executor !== 'function') throw new Error('executor is required');
  const scheduler = createScheduler({ maxConcurrency: concurrency, maxRetries, sequential });
  scheduler.submit(tasks);
  const results = new Map();
  const inflight = new Set();

  let pump = () => {
    while (!scheduler.isDone() && inflight.size < (sequential ? 1 : concurrency)) {
      const next = scheduler.dispatchNext();
      if (!next) break;
      const run = (async () => {
        try {
          const result = await executor(next);
          results.set(next.id, result);
          scheduler.markComplete(next.id, result);
        } catch (error) {
          scheduler.markFailed(next.id, error);
          if (!results.has(next.id)) results.set(next.id, { error: String(error?.message ?? error ?? 'failed') });
        } finally {
          inflight.delete(run);
          pump();
        }
      })();
      inflight.add(run);
    }
  };

  return new Promise((resolve) => {
    let settled = false;
    const check = () => {
      if (settled) return;
      if (scheduler.isDone() && inflight.size === 0) {
        settled = true;
        resolve({ results: Object.fromEntries(results), snapshot: scheduler.snapshot() });
      }
    };
    scheduler.onEvent(check);
    // Wrap pump so every completion path re-checks after inflight shrinks.
    const origPump = pump;
    pump = () => { origPump(); check(); };
    pump();
    // Cover the empty / all-sync case.
    check();
  });
}
