/** Completion of observed plan steps, never a time-based percentage estimate. */
export function promptProgress({ tasks = [], runState = 'idle', overviewReady = false, phase = 'working' } = {}) {
  const total = tasks.length;
  const completed = tasks.filter((task) => task.state === 'completed').length;
  const unfinished = total - completed;
  if (!total) {
    if (runState === 'done') return { fraction: 1, label: '100% complete', indeterminate: false };
    if (runState === 'idle') return { fraction: 0, label: 'ready', indeterminate: false };
    if (runState === 'error' || runState === 'aborted') return { fraction: 0, label: runState === 'aborted' ? 'cancelled' : 'incomplete', indeterminate: false };
    return { fraction: null, label: phase === 'planning' ? 'planning' : phase === 'recap' ? 'recap' : 'working', indeterminate: true };
  }
  const steps = total + 1; // The final overview is part of completing the prompt.
  const done = completed + (overviewReady && runState === 'done' ? 1 : 0);
  const fraction = Math.min(1, done / steps);
  const status = runState === 'aborted' ? 'cancelled' : runState === 'error' || runState === 'done' && unfinished ? 'incomplete'
    : phase === 'recap' ? 'recap' : fraction === 1 ? 'complete' : `${done}/${steps} steps`;
  return { fraction, label: `${Math.floor(fraction * 100)}% ${status}`, indeterminate: false, completed, total, unfinished };
}

export function progressBar(progress, width = 10, { now = 0, reducedMotion = false } = {}) {
  const cells = Math.max(4, Math.floor(width));
  if (progress.indeterminate) {
    const offset = reducedMotion ? 0 : Math.floor(now / 180) % (cells - 1);
    return `[${'░'.repeat(offset)}██${'░'.repeat(cells - offset - 2)}]`;
  }
  const filled = Math.floor(Math.max(0, Math.min(1, progress.fraction ?? 0)) * cells);
  return `[${'█'.repeat(filled)}${'░'.repeat(cells - filled)}]`;
}
