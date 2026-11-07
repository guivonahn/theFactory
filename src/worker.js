/**
 * Worker manager (Phase 3): each worker is an independent `opencode run`
 * process with its own session ID. Multiple workers of the same role allowed.
 * Built on launchRun (src/run.js). Zero dependencies.
 *
 * Worker record:
 * { workerId, runId, taskId, role, model, dir, sessionId, pid,
 *   state: queued|running|completed|failed|cancelled, startedAt, finishedAt,
 *   output, error, handle }
 */
import { launchRunWithFallback } from './run.js';
import { createEventBus } from './events.js';
import { skillPrompt } from './skills.js';

let workerSeq = 0;

export function buildWorkerPrompt({ objective, task, artifacts = [], graphifyGuide = null, registry } = {}) {
  const parts = [
    `Objective: ${objective ?? task?.title ?? ''}`,
    `Task: ${task?.title ?? ''} (${task?.id ?? ''})`,
  ];
  if (task?.acceptance) parts.push(`Acceptance: ${task.acceptance}`);
  if (task?.files?.length) parts.push(`Scope: ${task.files.join(', ')}`);
  if (artifacts.length) parts.push(`Inputs: ${artifacts.join(', ')}`);
  // Match the task against registered skills and inject the skill body so the
  // specialized agent follows the skill's instructions.
  if (registry) {
    const searchText = `${task?.title ?? ''} ${task?.acceptance ?? ''} ${objective ?? ''}`;
    for (const skill of registry.find(searchText)) parts.push(skillPrompt(skill));
  }
  parts.push('Do only the assigned task. Do not edit outside your workspace.');
  if (graphifyGuide) parts.push(graphifyGuide);
  return parts.join('\n');
}

export function createWorkerManager(options = {}) {
  const bus = options.bus ?? createEventBus();
  const workers = new Map();

  function workerId() { return `w_${Date.now()}_${(workerSeq += 1)}`; }

  function nextModel(requested, idx) {
    const fallbacks = options.fallbackModels ?? [];
    // Selector: requested model first, then fallbacks in order (bounded 8).
    const pool = [requested, ...fallbacks].filter(Boolean).slice(0, 8);
    if (pool.length === 0) return null;
    return pool[Math.min(idx ?? 0, pool.length - 1)];
  }

  function start({ runId, task, objective, artifacts = [], model, dir, bin, auto = false, registry } = {}) {
    if (!task?.id) throw new Error('task id is required');
    const id = workerId();
    const role = task.agent ?? 'orchestrator';
    const resolved = nextModel(model ?? options.model, workers.size);
    const record = {
      workerId: id, runId: runId ?? null, taskId: task.id, role, model: resolved ?? null,
      dir: dir ?? process.cwd(), sessionId: null, pid: null,
      state: 'queued', startedAt: Date.now(), finishedAt: null,
      output: '', error: null, handle: null,
    };
    workers.set(id, record);
    bus.publish({ runId: record.runId, workerId: id, taskId: task.id, kind: 'assigned', text: `${role}:${task.id} assigned` });

    const prompt = buildWorkerPrompt({
      objective,
      task,
      artifacts,
      graphifyGuide: options.graphifyGuide,
      registry,
    });

    const launchedPromise = launchRunWithFallback({
      task: prompt,
      agent: role,
      model: resolved,
      fallbackModels: options.fallbackModels ?? [],
      dir: record.dir,
      bin,
      auto,
      onSpawn: (pid) => { record.pid = pid; bus.publish({ runId, workerId: id, taskId: task.id, sessionId: record.sessionId, kind: 'started', text: `pid ${pid}`, meta: { pid } }); },
      onSessionID: (sid) => {
        record.sessionId = sid;
        bus.publish({ runId, workerId: id, taskId: task.id, sessionId: sid, kind: 'session', text: sid });
      },
      onEvent: (parsed) => {
        if (parsed.sessionID && !record.sessionId) record.sessionId = parsed.sessionID;
        if (parsed.text) record.output = parsed.text;
        if (parsed.error) record.error = parsed.error;
        for (const ev of parsed.events ?? []) {
          bus.publish({ runId, workerId: id, taskId: task.id, sessionId: record.sessionId ?? parsed.sessionID ?? null, kind: ev.kind, text: ev.text, meta: { fanout: !!ev.fanout, to: ev.to ?? null } });
        }
        if (parsed.diff) {
          bus.publish({ runId, workerId: id, taskId: task.id, sessionId: record.sessionId ?? parsed.sessionID ?? null, kind: 'status', text: parsed.diff });
        }
        if (parsed.permission) {
          bus.publish({ runId, workerId: id, taskId: task.id, sessionId: record.sessionId, kind: 'permission', text: `⚠ permission requested: ${parsed.permission.action}`, meta: parsed.permission });
        }
        if (parsed.error) {
          bus.publish({ runId, workerId: id, taskId: task.id, sessionId: record.sessionId, kind: 'failure', text: `✗ ${parsed.error}` });
        }
      },
      onHandle: (h) => { record.handle = h; },
      onRetry: (nextModel, reason) => { record.error = `retrying: ${reason}`; bus.publish({ runId, workerId: id, taskId: task.id, kind: 'status', text: `retrying on ${nextModel}` }); },
      onError: (error) => { record.error = String(error?.message ?? error); },
    });

    record.handle = null;
    record.handle = null;
    record.state = 'running';
    bus.publish({ runId, workerId: id, taskId: task.id, kind: 'worker-started', text: `${role} worker ${id} started` });

    const done = (async () => {
      const launched = await launchedPromise;
      const result = launched?.result;
      record.handle = launched?.handle ?? record.handle;
      record.finishedAt = Date.now();
      if (result?.error) { record.state = 'failed'; record.error = String(result.error?.message ?? result.error); }
      else if (result?.code === 0) record.state = 'completed';
      else { record.state = 'failed'; record.error = record.error ?? `exit ${result?.code}`; }
      bus.publish({ runId, workerId: id, taskId: task.id, sessionId: record.sessionId, kind: record.state, text: `${record.state}: ${task.id}`, meta: { code: result?.code ?? null } });
      return record;
    })();
    return { record, done, handle: record.handle };
  }

  function cancel(workerIdValue) {
    const record = workers.get(workerIdValue);
    if (!record) throw new Error(`unknown worker: ${workerIdValue}`);
    if (!record.handle) throw new Error(`worker not started: ${workerIdValue}`);
    const killed = record.handle.kill('SIGTERM');
    record.state = 'cancelled';
    bus.publish({ runId: record.runId, workerId: workerIdValue, taskId: record.taskId, sessionId: record.sessionId, kind: 'cancelled', text: `cancelled ${workerIdValue}` });
    return killed;
  }

  function list() { return [...workers.values()].map((r) => ({ workerId: r.workerId, taskId: r.taskId, role: r.role, sessionId: r.sessionId, state: r.state })); }
  function counts() {
    const out = { total: workers.size, queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0 };
    for (const r of workers.values()) out[r.state] = (out[r.state] ?? 0) + 1;
    return out;
  }
  return { bus, start, cancel, list, counts, workers };
}
