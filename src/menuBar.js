/** Local, read-only UI projection for the native macOS menu bar companion. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ORCHESTRATOR, resolveAgent } from './agents.js';
import { stripAnsi } from './canvas.js';
import { promptProgress } from './progress.js';

export function menuBarDirectory() {
  return process.env.FACTORY_MENUBAR_DIR || path.join(
    os.homedir(), 'Library', 'Application Support', 'theFactory', 'menu-bar',
  );
}

const text = (value, limit = 180) => stripAnsi(String(value ?? '')).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
const stateOf = (state) => ({ running: 'working', ready: 'queued', pending: 'queued', done: 'completed', error: 'failed', aborted: 'cancelled' })[state] || (['working', 'thinking', 'completed', 'failed', 'blocked', 'cancelled', 'queued'].includes(state) ? state : 'idle');

export function makeMenuBarSnapshot(app, { pid = process.pid, directory = process.cwd(), now = Date.now(), launchID = null } = {}) {
  const runState = app.run.state;
  const settled = app.mode === 'task' && runState !== 'running';
  const settle = (state) => settled && ['working', 'thinking', 'queued'].includes(state)
    ? runState === 'done' ? 'completed' : ['error', 'blocked'].includes(runState) ? 'blocked' : 'idle' : state;
  const agents = [];
  const add = (id, def, state, detail = '', sessionID = null) => agents.push({
    id: String(id), role: def.key, name: def.name || def.key, color: def.color,
    state: settle(stateOf(state)), detail: text(detail), sessionID,
  });
  add('orchestrator', ORCHESTRATOR, app.orchestratorWorker.workerState, app.run.detail || app.activity, app.run.sessionID || app.sessionID);
  for (const [key, agent] of app.agents) {
    if (key === 'other' && !app.showOther) continue;
    const workers = app.parallel.enabled ? app.parallel.workers.filter((worker) => resolveAgent(worker.role).key === key) : [];
    const sessions = !workers.length ? [...app.agentSessions.entries()].filter(([, session]) => session.agent === key) : [];
    const detail = agent.messages.at(-1)?.text || '';
    if (workers.length) {
      for (const worker of workers) {
        const task = app.parallel.tasks.find((entry) => entry.id === worker.taskId);
        add(worker.workerId, agent.def, worker.state, task?.title || detail, worker.sessionId || null);
      }
    } else if (sessions.length) {
      for (const [id, session] of sessions) add(id, agent.def, session.status, detail, id);
    } else add(key, agent.def, agent.workerState, detail, app.agentRuntime.get(key)?.sessionID || null);
  }
  const tasks = app.parallel.enabled ? app.parallel.tasks : app.promptTasks;
  const state = app.mode === 'live' && agents.some((agent) => ['working', 'thinking'].includes(agent.state)) ? 'running' : runState;
  return {
    schemaVersion: 1, id: String(pid), pid, updatedAt: now, launchID,
    mode: app.mode, directory, sessionID: app.run.sessionID || app.sessionID,
    title: text(app.run.objective || app.sessionTitle || path.basename(directory)),
    state, phase: app.runPhase, activity: text(app.run.detail || app.activity),
    elapsedSeconds: app.runElapsedSeconds(),
    progress: promptProgress({ tasks, runState: state, phase: app.runPhase, overviewReady: Boolean(app.completionOverview) }), agents,
    tasks: tasks.map((task) => ({ id: String(task.id), title: text(task.title || task.content), state: stateOf(task.state) })),
  };
}

/** Failure to publish must never affect agent work. Every TUI owns one file. */
export function startMenuBarPublisher(app, options = {}) {
  if ((options.platform || process.platform) !== 'darwin') return { close() {} };
  const directory = options.stateDirectory || menuBarDirectory();
  const pid = options.pid || process.pid;
  const file = path.join(directory, `${pid}.json`);
  const temp = `${file}.tmp`;
  let closed = false;
  const publish = () => {
    if (closed) return;
    try {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      const snapshot = makeMenuBarSnapshot(app, { ...options, pid });
      fs.writeFileSync(temp, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
      fs.renameSync(temp, file);
    } catch { try { fs.rmSync(temp, { force: true }); } catch {} }
  };
  publish();
  const timer = setInterval(publish, options.interval || 1000);
  timer.unref();
  return {
    close() {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      try { fs.rmSync(file, { force: true }); fs.rmSync(temp, { force: true }); } catch {}
    },
  };
}
