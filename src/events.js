/**
 * Structured event bus with run/worker/task/session attribution (Phase 3).
 * Zero dependencies. Dedupes by event id, preserves insertion order.
 */

let seq = 0;

export function createEventBus() {
  const events = [];
  const seen = new Set();
  const listeners = new Set();

  function publish(evt = {}) {
    const id = evt.id ?? `evt_${Date.now()}_${(seq += 1)}`;
    if (seen.has(id)) return null;
    seen.add(id);
    const event = {
      id,
      at: evt.at ?? Date.now(),
      runId: evt.runId ?? null,
      workerId: evt.workerId ?? null,
      taskId: evt.taskId ?? null,
      sessionId: evt.sessionId ?? null,
      kind: evt.kind,
      text: evt.text ?? '',
      meta: evt.meta ?? {},
    };
    if (!event.kind) throw new Error('event kind is required');
    events.push(event);
    if (events.length > 2000) { events.shift(); }
    for (const fn of listeners) { try { fn(event); } catch {} }
    return event;
  }

  function onEvent(fn) { if (typeof fn === 'function') listeners.add(fn); return () => listeners.delete(fn); }
  function list(filter = {}) {
    return events.filter((e) =>
      (!filter.runId || e.runId === filter.runId) &&
      (!filter.workerId || e.workerId === filter.workerId) &&
      (!filter.taskId || e.taskId === filter.taskId) &&
      (!filter.sessionId || e.sessionId === filter.sessionId) &&
      (!filter.kind || e.kind === filter.kind));
  }
  function counts() {
    const byKind = {};
    for (const e of events) byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
    return { total: events.length, byKind };
  }
  function clear() { events.length = 0; seen.clear(); }
  return { publish, onEvent, list, counts, clear };
}
