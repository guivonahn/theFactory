/**
 * Visualizer state machine: consumes agent events, animates packets along
 * branch paths, and paints frames into a diffed character canvas.
 */

import { AGENTS, AGENT_ORDER, ORCHESTRATOR, agentByKey, resolveAgent } from './agents.js';
import { Canvas, charWidth, displayWidth, stripAnsi, truncate, wrapText } from './canvas.js';
import { themeFor, APPLE_UIKIT } from './colors.js';
import { buildLayout, trackCellsFor } from './layout.js';
import { highlightLine } from './highlight.js';
import { formatReset } from './goUsage.js';
import { drawFactory, factoryGeometry } from './factory.js';
import { formatLogEntries, LOG_FILTERS, logMatches } from './logFormat.js';
import { drawWorker, prefersReducedMotion, WORKER_DESIGNS } from './creatures.js';
import { promptProgress, progressBar } from './progress.js';
import {
  createQuestionState,
  currentField,
  fieldOptions,
  handleQuestionKey as handleFormKey,
} from './forms.js';

const T = themeFor('dark'); // terminalThemes.dark tokens (exact JSON hex)
const GRAY = APPLE_UIKIT.dark.system;

const PACKET_SPEED = 0.018; // cells per millisecond
const STEP_MS = 16;
const SPINNER_FRAMES = ['◐', '◓', '◑', '◒'];

/** Config overlay rows in display order; editable rows respond to enter/arrows. */
const CONFIG_ROWS = [
  { key: 'model', label: 'all agents', editable: true },
  ...['orchestrator', ...AGENT_ORDER].map((key) => ({ key: `agent:${key}`, label: key, editable: true })),
  { key: 'profile', label: 'profile', editable: true },
  { key: 'verbose', label: 'verbose', editable: true },
  { key: 'autoFallback', label: 'autoFallback', editable: true },
  { key: 'auto', label: 'auto', editable: true },
  { key: 'parallel', label: 'parallel', editable: true },
  { key: 'sequential', label: 'sequential', editable: true },
  { key: 'nolimit', label: 'nolimit', editable: true },
  { key: 'graphify', label: 'graphify', editable: true },
  { key: 'volume', label: 'volume', editable: true },
  { key: 'dir', label: 'dir', editable: false },
  { key: 'session', label: 'session', editable: false },
];

function freshAgent(def) {
  return {
    def,
    messages: [],
    history: [],
    messageCount: 0,
    toolCount: 0,
    sessions: 1,
    status: 'idle',
    workerState: 'idle',
    workerSince: 0,
    flashUntil: 0,
    pulseUntil: 0,
  };
}

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function statusGlyph(state, now, spinner = '●') {
  if (state.workerState === 'failed') return { glyph: '?', color: T.warning };
  if (state.status === 'done') return { glyph: '✓', color: T.success };
  if (state.status === 'working') return { glyph: spinner, color: state.def.color };
  const pulse = Math.floor(now / 450) % 2 === 0;
  return { glyph: '○', color: pulse ? T.textSecondary : T.border };
}

export class App {
  /**
   * @param {{width?: number, height?: number, color?: boolean, mode?: string}} [options]
   */
  constructor(options = {}) {
    this.width = options.width ?? 80;
    this.height = options.height ?? 24;
    this.color = options.color !== false;
    this.mode = options.mode ?? 'demo';
    this.inputMode = Boolean(options.inputMode);
    this.reducedMotion = options.reducedMotion ?? prefersReducedMotion();
    this.workerPreview = Boolean(options.workerPreview);
    this.factoryPreview = Boolean(options.factoryPreview);
    this.orchestratorWorker = { workerState: 'idle', workerSince: 0 };
    // Sound hook: (name: 'pop' | 'error') => void. The TUI wires this to
    // src/sound.js; snapshots/tests leave it null so replay stays silent.
    this.onSound = typeof options.onSound === 'function' ? options.onSound : null;
    this.footerRows = this.inputMode ? 3 : 1;
    this.canvas = new Canvas(this.width, this.height, { color: this.color });
    this.layout = buildLayout(this.width, this.height, { footerRows: this.footerRows, workers: true });
    this._indexSlots();

    this.agents = new Map();
    for (const key of [...AGENT_ORDER, 'other']) {
      const def = agentByKey(key) ?? resolveAgent(key);
      this.agents.set(key, freshAgent(def));
    }
    this.showOther = false;

    this.packets = [];
    this.now = 0;
    this.totalMessages = 0;
    this.totalTools = 0;
    this.totalTokens = 0;
    this.totalKb = 0;
    this.activity = 'awaiting first task';
    this.goUsage = null;
    this.centerFlashUntil = 0;
    this.centerFlashColor = T.textPrimary;
    this.centerLog = [];
    this.orchestratorHistory = [];
    this.logRevision = 0;
    this.logCache = null;
    this.logEntryCache = new WeakMap();
    this.agentRuntime = new Map();
    this.logView = { open: false, agentKey: 'orchestrator', scroll: 0, filter: 'all', paused: false };
    this.configView = { open: false, selected: 'model', scroll: 0, info: {} };
    this.modelPicker = { open: false, key: null, models: [], selected: 0, scroll: 0 };
    this.imageView = { open: false, image: null };
    this.questionView = { open: false };
    this.sessionID = null;
    this.sessionTitle = null;
    this.inputValue = '';
    this.inputCursor = 0;
    this.promptTasks = [];
    this.runPhase = 'working';
    this.completionOverview = null;
    this.run = {
      state: 'idle',
      pid: null,
      sessionID: null,
      startedAt: 0,
      duration: 0,
      detail: '',
    };
    this.parallel = {
      enabled: false,
      tasks: [],
      concurrency: 3,
      workers: [
        // { workerId, taskId, role, sessionId, state }
      ],
      counts: { queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0 },
    };
    if (this.workerPreview) {
      const poses = ['working', 'thinking', 'idle', 'completed', 'failed', 'working'];
      AGENT_ORDER.forEach((key, index) => {
        const state = this.agents.get(key);
        state.status = poses[index] === 'completed' ? 'done' : poses[index] === 'failed' || poses[index] === 'idle' ? 'idle' : 'working';
        state.workerState = poses[index];
        state.messages.push({ dir: 'in', text: `${this._workerDesign(this._slots.get(key))} · ${poses[index]}` });
      });
      this.activity = 'Worker audition · dumpling selected';
      this.orchestratorWorker.workerState = 'thinking';
    }
    if (this.factoryPreview) {
      this.activity = 'Factory preview · a little team at work';
      this.orchestratorWorker.workerState = 'thinking';
      this.setAgentStatus('explorer', 'done');
      this.setAgentStatus('architect', 'done');
      this.setParallelTasks([
        { id: 'map', state: 'completed' }, { id: 'design', state: 'completed' },
        { id: 'ui', state: 'running' }, { id: 'engine', state: 'running' },
        { id: 'review', state: 'running' }, { id: 'verify', state: 'pending' },
      ], 4);
      this.setParallelWorkers([
        { workerId: 'preview-ui', taskId: 'ui', role: 'developer', state: 'running' },
        { workerId: 'preview-engine', taskId: 'engine', role: 'developer', state: 'running' },
        { workerId: 'preview-review', taskId: 'review', role: 'reviewer', state: 'running' },
      ]);
      this._setWorker(this.agents.get('developer'), 'working');
      this.agents.get('developer').messages.push({ dir: 'out', text: 'UI and engine · two independent scopes' });
      this.agents.get('reviewer').messages.push({ dir: 'out', text: 'Inspecting the finished design' });
    }
  }

  _indexSlots() {
    this._slots = new Map();
    if (!this.layout.tooSmall) {
      for (const slot of this.layout.agents) this._slots.set(slot.key, slot);
      this._slots.set('other', this.layout.other);
      this._tracks = trackCellsFor(this.layout.agents);
      this._otherTracks = trackCellsFor([...this.layout.agents, this.layout.other]);
    }
  }

  /** Resize the canvas and rebuild radial geometry. Returns false below 60x24. */
  resize(width, height) {
    this.width = width;
    this.height = height;
    this.canvas.resize(width, height);
    this.layout = buildLayout(width, height, { footerRows: this.footerRows, workers: true });
    this._indexSlots();
    for (const packet of this.packets) {
      const slot = this._slots.get(packet.agentKey);
      if (!slot) continue;
      const fraction = packet.progress / Math.max(1, packet.path.length - 1);
      packet.path = packet.dir === 'in' ? [...slot.returnPath].reverse() : slot.path;
      packet.progress = fraction * Math.max(0, packet.path.length - 1);
    }
    return !this.layout.tooSmall;
  }

  get tooSmall() {
    return Boolean(this.layout.tooSmall);
  }

  /** Fire a sound cue (pop/error). Failures are swallowed: audio never breaks rendering. */
  cueSound(name) {
    if (!this.onSound) return;
    try { this.onSound(name); } catch {}
  }

  /** Update the live-session subtitle count for an agent pillar. */
  setSessionCount(key, count) {
    const state = this.agents.get(key);
    if (state) state.sessions = Math.max(1, count | 0);
  }

  setGoUsage(usage) {
    this.goUsage = usage ?? null;
  }

  /** Set the current session id + optional title/slug for the header. */
  setSession(id, title = null) {
    if (id === null) { this.sessionID = null; this.sessionTitle = null; return; }
    if (typeof id === 'string' && id) this.sessionID = id;
    if (title != null) {
      const t = String(title).trim();
      if (t) this.sessionTitle = t;
    }
  }

  _spinner() {
    return SPINNER_FRAMES[this.reducedMotion ? 0 : Math.floor(this.now / 180) % SPINNER_FRAMES.length];
  }

  /** Keep a small orchestrator log (20 entries max) for task mode. */
  addLog(text, metadata = {}) {
    const line = stripAnsi(text).replace(/\r\n/g, '\n');
    if (!line) return;
    this.centerLog.push(line);
    if (this.centerLog.length > 20) this.centerLog.shift();
    this._appendLog(this.orchestratorHistory, { kind: 'status', at: this.now, ...metadata, text: line });
  }

  setAgentRuntime(agent, info) {
    this.agentRuntime.set(agent, { ...this.agentRuntime.get(agent), ...info });
  }

  recordAgentLog(agent, entry) {
    if (agent === 'orchestrator') this.addLog(entry.text, entry);
    else this._pushHistory(this.agents.get(this._agentKey(agent)), { at: this.now, ...entry });
    if (entry.model || entry.sessionID) this.setAgentRuntime(agent, { ...(entry.model ? { model: entry.model } : {}), ...(entry.sessionID ? { sessionID: entry.sessionID } : {}) });
  }

  /** Open the per-agent log overlay for the given agent key. */
  openLog(agentKey = 'orchestrator') {
    const key = agentKey === 'orchestrator' ? 'orchestrator' : this._agentKey(agentKey);
    this.logView.open = true;
    this.logView.overview = false;
    this.logView.agentKey = key;
    this.logView.scroll = 0;
    this.logView.paused = false;
  }

  setCompletionOverview(text, { open = true } = {}) {
    this.completionOverview = { text: stripAnsi(text), kind: 'message', dir: 'in', at: this.now };
    this.addLog(text, { kind: 'message', dir: 'in' });
    if (open) this.openOverview();
  }

  openOverview() {
    if (!this.completionOverview) return false;
    this.openLog('orchestrator');
    this.logView.overview = true;
    this.logView.scroll = Number.MAX_SAFE_INTEGER;
    this.logView.paused = true;
    return true;
  }

  setPromptTasks(tasks) {
    this.promptTasks = tasks.map((task, index) => ({
      id: task.id || `step-${index + 1}`, title: String(task.content || task.title || `Step ${index + 1}`),
      state: ({ in_progress: 'running', pending: 'pending', completed: 'completed', cancelled: 'cancelled' })[task.status] || task.state || 'pending',
    }));
  }

  getPromptProgress() {
    return promptProgress({ tasks: this.parallel.enabled ? this.parallel.tasks : this.promptTasks, runState: this.run.state, phase: this.runPhase, overviewReady: Boolean(this.completionOverview) });
  }

  /** Map a terminal (1-based) click to an agent whose msg counter was hit. */
  hitAgentMsg(x, y) {
    const cy = y - 1;
    const cx = x - 1;
    for (const [key] of this.agents) {
      if (key === 'other' && !this.showOther) continue;
      const slot = this._slots.get(key);
      if (!slot) continue;
      const box = slot.box;
      if (slot.worker && cy >= slot.worker.row && cy < box.row && cx >= box.col && cx < box.col + box.width) return key;
      if (box.height < 5 && cy >= box.row && cy < box.row + box.height && cx >= box.col && cx < box.col + box.width) return key;
      const statsRow = box.row + box.height - 2;
      if (cy !== statsRow) continue;
      if (cx < box.col + 2 || cx > box.col + box.width - 3) continue;
      return key;
    }
    return null;
  }

  /** Close the log overlay. */
  closeLog() {
    this.logView.open = false;
  }

  /** Open the config overlay with a snapshot of the current settings. */
  openConfig(info = {}) {
    this.configView.info = { ...info };
    this.configView.selected = 'model';
    this.configView.scroll = 0;
    this.configView.open = true;
  }

  /** Update the config overlay's settings snapshot without opening/closing it. */
  updateConfigInfo(info = {}) {
    this.configView.info = { ...info };
  }

  /** Move the config cursor to the previous/next editable row. dir is ±1. */
  moveConfigSelection(dir) {
    const editable = CONFIG_ROWS.filter((row) => row.editable);
    if (editable.length === 0) return;
    let index = editable.findIndex((row) => row.key === this.configView.selected);
    if (index < 0) index = dir < 0 ? editable.length - 1 : 0;
    else index = (index + (dir < 0 ? -1 : 1) + editable.length) % editable.length;
    this.configView.selected = editable[index].key;
  }

  /** Close the config overlay. */
  closeConfig() {
    this.configView.open = false;
    this.modelPicker.open = false;
  }

  openModelPicker(key, models, current) {
    const selected = models.indexOf(current?.split('#')[0] ?? null);
    this.modelPicker = { open: true, key, models, selected: Math.max(0, selected), scroll: 0 };
  }

  moveModelPicker(delta) {
    const picker = this.modelPicker;
    if (picker.models.length) picker.selected = ((picker.selected + delta) % picker.models.length + picker.models.length) % picker.models.length;
  }

  jumpModelPickerToCoarena() {
    const index = this.modelPicker.models.findIndex((model) => model?.startsWith('coarena-'));
    if (index >= 0) this.modelPicker.selected = index;
  }

  closeModelPicker() { this.modelPicker.open = false; }

  modelPickerChoice() {
    const { key, models, selected } = this.modelPicker;
    return { key, model: models[selected] };
  }

  /** Open a pending OpenCode form without coupling the view to API transport. */
  openQuestion(form, { sessionID } = {}) {
    this.questionView = createQuestionState(form, sessionID);
    return this.questionView;
  }

  closeQuestion() {
    this.questionView = { open: false };
  }

  setQuestionError(message) {
    if (this.questionView.open) this.questionView.error = String(message ?? 'question reply failed');
  }

  handleQuestionKey(buffer) {
    if (!this.questionView.open) return null;
    return handleFormKey(this.questionView, buffer);
  }

  openImage(image) {
    if (!image || typeof image !== 'object') return;
    this.imageView = { open: true, image };
  }

  closeImage() {
    this.imageView.open = false;
  }

  /** Cycle through orchestrator + 6 pillars + other. dir is ±1. */
  cycleLogAgent(dir) {
    this.logView.overview = false;
    const order = ['orchestrator', ...AGENT_ORDER, 'other'];
    let index = order.indexOf(this.logView.agentKey);
    if (index < 0) index = 0;
    const next = (index + (dir < 0 ? -1 : 1) + order.length) % order.length;
    this.logView.agentKey = order[next];
    this.logView.scroll = 0;
    this.logView.paused = false;
  }

  /** Scroll the log overlay by delta lines (negative = toward the bottom). */
  scrollLog(delta) {
    // scroll = how many entries up from the newest (0 shows latest at bottom).
    this.logView.scroll = Math.max(0, this.logView.scroll - Math.trunc(delta));
  }

  cycleLogFilter() {
    if (this.logView.overview) return;
    this.logView.filter = LOG_FILTERS[(LOG_FILTERS.indexOf(this.logView.filter) + 1) % LOG_FILTERS.length];
    this.logView.scroll = 0;
    this.logCache = null;
  }

  jumpLog(latest = true) {
    this.logView.scroll = latest ? 0 : Number.MAX_SAFE_INTEGER;
    this.logView.paused = !latest;
  }

  toggleLogFollow() {
    if (this.logView.paused || this.logView.scroll > 0) { this.logView.paused = false; this.logView.scroll = 0; }
    else this.logView.paused = true;
  }

  /** Entries for the selected log-view agent (orchestrator uses centerLog). */
  _logEntries() {
    if (this.logView.overview && this.completionOverview) return [this.completionOverview];
    const key = this.logView.agentKey;
    const entries = key === 'orchestrator' ? this.orchestratorHistory : this.agents.get(key)?.history ?? [];
    return entries.filter((entry) => logMatches(entry, this.logView.filter));
  }

  /** Visible wrapped log rows for the overlay (shared by _drawLog and tests). */
  _logLines(visibleRows) {
    return this._logRows(visibleRows).map((line) => line.text);
  }

  _logRows(visibleRows) {
    const width = this.width - 8;
    const key = `${this.logView.agentKey}:${this.logView.filter}:${Boolean(this.logView.overview)}:${width}`;
    if (!this.logCache || this.logCache.key !== key || this.logCache.revision !== this.logRevision) {
      const previous = this.logCache;
      const lines = this._logEntries().flatMap((entry) => {
        let cached = this.logEntryCache.get(entry);
        if (!cached || cached.width !== width) {
          cached = { width, lines: formatLogEntries([entry], width) };
          this.logEntryCache.set(entry, cached);
        }
        return cached.lines;
      }).slice(this.logView.overview ? 1 : 0);
      if (previous?.key === key && (this.logView.scroll > 0 || this.logView.paused)) {
        this.logView.scroll += Math.max(0, lines.length - previous.lines.length);
      }
      this.logCache = { key, revision: this.logRevision, lines };
    }
    const lines = this.logCache.lines;
    const maxScroll = Math.max(0, lines.length - Math.max(1, visibleRows));
    const scroll = Math.min(this.logView.scroll, maxScroll);
    this.logView.scroll = scroll;
    const end = lines.length - scroll;
    const start = Math.max(0, end - Math.max(1, visibleRows));
    return lines.slice(start, end);
  }

  /** Write one line with inline keyword highlighting. */
  _writeHighlighted(row, col, text, width, baseStyle = T.textPrimary) {
    const line = truncate(text, width);
    let cursor = col;
    for (const segment of highlightLine(line, baseStyle)) {
      cursor = this.canvas.write(row, cursor, segment.text, segment.style);
    }
    return cursor;
  }
  setInputValue(value, cursor = null) {
    this.inputValue = String(value ?? '');
    const length = Array.from(this.inputValue).length;
    this.inputCursor = cursor == null ? length : Math.max(0, Math.min(length, cursor));
  }

  /** Enter the running state for a spawned task. */
  startRun({ pid = null, sessionID = null, resumed = false, parallel = null, objective = '' } = {}) {
    this.promptTasks = [];
    this.runPhase = parallel ? 'planning' : 'working';
    this.completionOverview = null;
    this.parallel = { enabled: Boolean(parallel), workers: [], tasks: [], concurrency: parallel?.workers ?? 3, counts: { queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0 } };
    this._setWorker(this.orchestratorWorker, 'thinking');
    this.run = {
      state: 'running',
      objective,
      pid,
      sessionID,
      resumed: Boolean(resumed),
      parallel: parallel && typeof parallel === 'object' ? { workers: parallel.workers ?? null } : null,
      startedAt: this.now,
      duration: 0,
      detail: '',
    };
    this.activity = resumed ? 'continuing session' : 'running task';
    this.centerFlashUntil = this.now + 300;
    this.centerFlashColor = T.textPrimary;
  }

  setRunPid(pid) {
    if (this.run.state === 'running' && pid) this.run.pid = pid;
  }

  setRunSession(sessionID) {
    if (this.run.state === 'running' && sessionID) this.run.sessionID = sessionID;
  }

  /** Replace parallel worker panel from real manager counts (no invention). */
  setParallelWorkers(workers) {
    this.parallel.enabled = true;
    this.parallel.workers = Array.isArray(workers) ? workers.slice() : [];
    const counts = { queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0 };
    for (const w of this.parallel.workers) {
      if (w.state && counts[w.state] !== undefined) counts[w.state] += 1;
    }
    this.parallel.counts = counts;
    const groups = new Map();
    for (const worker of this.parallel.workers) {
      const key = this._agentKey(worker.role);
      const group = groups.get(key) ?? [];
      group.push(worker);
      groups.set(key, group);
    }
    for (const [key, state] of this.agents) {
      const group = groups.get(key) ?? [];
      state.workerCount = group.filter((worker) => worker.state === 'running' || worker.state === 'queued').length;
      if (!group.length) continue;
      if (key === 'other') this.showOther = true;
      if (state.workerCount) {
        state.status = 'working';
        if (!['working', 'thinking'].includes(state.workerState)) this._setWorker(state, 'thinking');
      } else if (group.some((worker) => worker.state === 'failed')) {
        state.status = 'idle'; this._setWorker(state, 'failed');
      } else if (group.some((worker) => worker.state === 'completed')) {
        state.status = 'done'; this._setWorker(state, 'completed');
      } else { state.status = 'idle'; this._setWorker(state, 'idle'); }
    }
    return counts;
  }

  setParallelTasks(tasks, concurrency = this.parallel.concurrency) {
    this.parallel.tasks = Array.isArray(tasks) ? tasks.map((task) => ({ ...task })) : [];
    this.parallel.concurrency = concurrency;
  }

  _parallelSummary() {
    const tasks = this.parallel.tasks;
    const count = (states) => tasks.filter((task) => states.includes(task.state)).length;
    const running = tasks.length ? count(['running']) : this.parallel.counts.running;
    const waiting = count(['pending', 'ready']);
    const completed = tasks.length ? count(['completed']) : this.parallel.counts.completed;
    const bad = count(['failed', 'blocked', 'cancelled']);
    return `${running}/${this.parallel.concurrency} run ${bad ? `!${bad}` : `q${waiting}`} ✓${completed}`;
  }

  setParallelEnabled(enabled) {
    this.parallel.enabled = Boolean(enabled);
  }

  runElapsedSeconds() {
    if (this.run.state === 'running') return Math.max(0, Math.floor((this.now - this.run.startedAt) / 1000));
    return Math.max(0, Math.floor(this.run.duration / 1000));
  }

  /** Reset every agent still marked working back to a settled state. */
  settleWorkingAgents(status = 'done') {
    for (const state of this.agents.values()) {
      if (state.status === 'working') {
        state.status = status === 'idle' || status === 'error' ? 'idle' : 'done';
        this._setWorker(state, state.status === 'done' ? 'completed' : status === 'error' ? 'failed' : 'idle');
        if (state.status === 'done') state.flashUntil = this.now + 500;
      }
    }
  }

  /** Set one agent's status explicitly (used by the parallel bus). */
  setAgentStatus(name, status) {
    const key = this._agentKey(name);
    const state = this.agents.get(key);
    if (!state) return;
    if (status === 'done') {
      state.status = 'done';
      state.flashUntil = this.now + 500;
    } else if (status === 'idle') {
      state.status = 'idle';
    } else if (status === 'working') {
      if (state.status !== 'working') this.cueSound('pop');
      state.status = 'working';
    } else if (status === 'thinking') {
      state.status = 'working';
    } else if (status === 'error' || status === 'failed') {
      state.status = 'idle';
    }
    this._setWorker(state, status === 'done' ? 'completed' : status === 'error' || status === 'failed' ? 'failed' : status);
  }

  _setWorker(state, pose) {
    if (state.workerState === pose) return;
    state.workerState = pose;
    state.workerSince = this.now;
  }

  /** Mark the current run done, aborted or failed. */
  finishRun(state, detail = '') {
    // Error cue first: finishRun('error') is the terminal signal for task
    // failures, nolimit/viewer setup errors and permission failures.
    if (state === 'error') this.cueSound('error');
    else if (state === 'done') this.cueSound('completed');
    const duration = this.run.state === 'running' ? Math.max(0, this.now - this.run.startedAt) : this.run.duration;
    this.run = { ...this.run, state, duration, detail: clean(detail) };
    this._setWorker(this.orchestratorWorker, state === 'done' ? 'completed' : state === 'error' ? 'failed' : 'idle');
    // A finished run must clear the ACTIVE AGENTS panel; otherwise pillars
    // fed by live worker messages stay stuck on spinner-forever "working".
    this.settleWorkingAgents(state === 'done' ? 'done' : state === 'error' ? 'error' : 'idle');
    if (state === 'done') {
      const suffix = this.run.detail ? ` · ${truncate(this.run.detail, 56)}` : '';
      this.activity = `✓ task complete in ${Math.max(1, Math.floor(duration / 1000))}s${suffix}`;
      this.centerFlashColor = T.success;
      this.centerFlashUntil = this.now + 500;
    } else if (state === 'aborted') {
      this.activity = '■ task aborted';
      this.centerFlashColor = T.textSecondary;
      this.centerFlashUntil = this.now + 350;
    } else if (state === 'error') {
      this.activity = `✗ ${truncate(this.run.detail || 'run failed', 70)}`;
      this.centerFlashColor = T.error;
      this.centerFlashUntil = this.now + 1200;
    }
  }

  _runStatusLine() {
    const panel = this.parallel?.enabled
      ? ` · workers q${this.parallel.counts.queued} r${this.parallel.counts.running} ✓${this.parallel.counts.completed} ✗${this.parallel.counts.failed}`
      : '';
    if (this.run.state === 'running') {
      const pid = this.run.pid ?? '…';
      const session = this.run.sessionID ? this.run.sessionID.slice(0, 14) : '…';
      const mode = this.run.resumed ? 'continued' : 'new';
      const par = this.run.parallel?.workers ? ` · parallel/${this.run.parallel.workers}w` : (panel ? ` · parallel` : '');
      return `running: opencode (pid ${pid}) · ${mode} · session ${session}${par}${panel} · ${this.runElapsedSeconds()}s`;
    }
    if (this.run.state === 'done') return `✓ task complete in ${this.runElapsedSeconds()}s`;
    if (this.run.state === 'aborted') return `■ aborted after ${this.runElapsedSeconds()}s`;
    if (this.run.state === 'error') return `✗ ${truncate(this.run.detail || 'run failed', 44)}`;
    const session = this.run.sessionID ? ` · session ${this.run.sessionID.slice(0, 12)}` : '';
    return `ready · type a task${session}`;
  }

  _agentKey(name) {
    return resolveAgent(name).key;
  }

  _slotFor(key) {
    return this._slots.get(key) ?? null;
  }

  _addMessage(state, dir, text) {
    state.messages.push({ dir, text });
    if (state.messages.length > 16) state.messages.shift();
    state.messageCount += 1;
  }

  /** Append one entry to an agent's full history (cap 500). */
  _pushHistory(state, entry) {
    if (!state) return;
    this._appendLog(state.history, entry);
  }

  _appendLog(history, entry) {
    const existing = entry.id ? history.findIndex((record) => record.id === entry.id) : -1;
    if (existing >= 0) history[existing] = { ...history[existing], ...entry };
    else history.push(entry);
    if (history.length > 500) history.shift();
    this.logRevision += 1;
  }

  _spawn(path, color, options = {}) {
    const size = options.size ?? ((path.length % 3) + 1);
    // One little node per KB of payload (capped so 12 MB doesn't stall the path).
    const nodes = Math.max(1, Math.min(12, Math.ceil((options.bytes ?? 1024) / 1024)));
    this.packets.push({
      path,
      color,
      size,
      nodes,
      progress: 0,
      speed: options.speed ?? PACKET_SPEED,
      startAt: this.now + (options.delay ?? 0),
      agentKey: options.agentKey ?? null,
      dir: options.dir ?? 'out',
      arrived: false,
    });
  }

  /** Apply one semantic event ({kind:'msg'|'tool'|'status', ...}). */
  applyEvent(event) {
    if (!event || typeof event !== 'object') return;
    if (event.kind === 'msg') this._applyMessage(event);
    else if (event.kind === 'tool') this._applyTool(event);
    else if (event.kind === 'status') this._applyStatus(event);
  }

  _applyMessage(event) {
    const dir = event.dir === 'in' ? 'in' : 'out';
    const source = dir === 'in' ? event.from : (event.to ?? event.from);
    if (!source) return;
    const key = this._agentKey(source);
    const state = this.agents.get(key);
    if (!state) return;
    if (key === 'other') this.showOther = true;

    const text = clean(event.text);
    if (!text) return;

    this._addMessage(state, dir, text);
    if (!event.logRecorded) this._pushHistory(state, { dir, text: stripAnsi(event.text), kind: 'msg', at: this.now, ...event.logEntry });
    if (event.logEntry?.model) this.setAgentRuntime(key, { model: event.logEntry.model });
    this.totalMessages += 1;
    this.totalTokens += Math.max(1, Math.ceil(text.length / 4));
    // Real payload size in bytes drives the KB node count downstream.
    const bytes = event.bytes ?? Buffer.byteLength(text, 'utf8');
    state.status = 'working';
    this._setWorker(state, 'thinking');
    this._setWorker(this.orchestratorWorker, 'thinking');
    // Orchestrator -> agent: "an agent is called" gets the pop cue.
    if (dir === 'out') this.cueSound('pop');

    const verb = dir === 'out' ? '→' : '←';
    this.activity = `${verb} ${state.def.label.toLowerCase()}: ${truncate(text, 64)}`;

    const slot = this._slotFor(key);
    if (!slot) return;
    this.totalKb += bytes / 1024;
    // Out rides the outbound lane; the reply rides the return lane.
    const path = dir === 'out' ? slot.path : [...(slot.returnPath ?? slot.path)].reverse();
    this._spawn(path, state.def.color, { agentKey: key, dir, bytes });
  }

  _applyTool(event) {
    const key = this._agentKey(event.from ?? event.agent ?? 'other');
    if (key === 'orchestrator') {
      this._setWorker(this.orchestratorWorker, event.logEntry?.status === 'error' ? 'failed' : 'working');
      const detail = clean(event.text);
      if (!event.logRecorded) this.addLog(event.logEntry?.text ?? event.text, { kind: 'tool', ...event.logEntry });
      this.totalTools += 1;
      this.totalKb += 1;
      this.centerFlashUntil = this.now + 220;
      this.activity = `tool: ${detail || 'running tool'}`;
      if (!event.fanout) return;
      // A fanned-out tool (subagent/task) is the orchestrator calling an agent.
      this.cueSound('pop');
      const targets = event.to ? [this._agentKey(event.to)] : [...AGENT_ORDER];
      targets.forEach((target, index) => {
        const slot = this._slotFor(target);
        if (!slot) return;
        const state = this.agents.get(target);
        this._spawn(slot.path, state?.def.color ?? T.textSecondary, {
          agentKey: target,
          dir: 'out',
          delay: index * 55,
          speed: 0.04,
          size: 2,
          bytes: 1024,
        });
      });
      return;
    }
    const state = this.agents.get(key);
    if (!state) return;
    if (key === 'other') this.showOther = true;
    // A pillar running a tool is an agent actively called on the job.
    this.cueSound('pop');
    state.toolCount += 1;
    state.status = 'working';
    this._setWorker(state, event.logEntry?.status === 'error' ? 'failed' : 'working');
    state.pulseUntil = this.now + 1000;
    this.totalTools += 1;
    this.totalKb += 1;
    const detail = clean(event.text);
    if (!event.logRecorded) this._pushHistory(state, { dir: 'tool', text: stripAnsi(event.text) || 'running tool', kind: 'tool', at: this.now, ...event.logEntry });
    if (event.logEntry?.model) this.setAgentRuntime(key, { model: event.logEntry.model });
    this.activity = `${state.def.label.toLowerCase()}: ${detail || 'running tool'}`;

    const slot = this._slotFor(key);
    if (!slot) return;
    for (let i = 0; i < 4; i += 1) {
      const outbound = i % 2 === 0;
      // Alternates out / back across the two lanes (ping-pong data flow).
      const lane = outbound ? slot.path : [...(slot.returnPath ?? slot.path)].reverse();
      this._spawn(lane, state.def.color, {
        agentKey: key,
        dir: outbound ? 'out' : 'in',
        delay: i * 130,
        speed: 0.055,
        size: 1,
        bytes: 1024,
      });
    }
  }

  _applyStatus(event) {
    const text = clean(event.text);
    if (event.from === ORCHESTRATOR.key || !event.from) {
      if (event.state) this._setWorker(this.orchestratorWorker, event.state === 'done' ? 'completed' : event.state === 'error' || event.state === 'failed' ? 'failed' : event.state);
      if (text) this.activity = text;
      this.centerFlashUntil = this.now + 180;
      if (text && !event.logRecorded) this.addLog(event.logEntry?.text ?? event.text, event.logEntry);
      return;
    }
    const key = this._agentKey(event.from);
    const state = this.agents.get(key);
    if (!state) return;
    if (key === 'other') this.showOther = true;
    if (text && !event.logRecorded) this._pushHistory(state, { dir: 'status', text: stripAnsi(event.text), kind: 'status', at: this.now, ...event.logEntry });
    const lowered = text.toLowerCase();
    const failed = event.state === 'error' || event.state === 'failed' || /✗|\b(?:fail(?:ed|ure)?|error)\b/.test(lowered);
    const settled = event.state === 'idle' || failed || /\b(?:idle|cancel(?:led|ed)?|abort(?:ed)?)\b/.test(lowered);
    const completed = /\b(?:done|complete[ds]?|finish(?:ed)?)\b/.test(lowered);
    // Explicit terminal state wins first, then keyword heuristics. Failure
    // keywords must settle to idle — previously any unknown status text fell
    // through to "working", so "✗ failed" left the agent spinning forever.
    if (event.state === 'done') {
      state.status = 'done';
      state.flashUntil = this.now + 500;
    } else if (settled) {
      state.status = 'idle';
      // Tool/runtime failures surface as error cues (finishRun covers the
      // terminal task failure; this covers mid-run pillar failures).
      if (failed) this.cueSound('error');
    } else if (event.state === 'working' || event.state === 'thinking') {
      state.status = 'working';
    } else if (completed) {
      state.status = 'done';
      state.flashUntil = this.now + 500;
    } else {
      state.status = 'working';
    }
    this._setWorker(state, state.status === 'done' ? 'completed' : failed ? 'failed'
      : state.status === 'idle' ? 'idle' : /think|plan|wait|reason/.test(lowered) || event.state === 'thinking' ? 'thinking' : 'working');
    if (text) this.activity = `${state.def.label.toLowerCase()}: ${truncate(text, 64)}`;
  }

  _step(ms) {
    const survivors = [];
    for (const packet of this.packets) {
      if (packet.arrived) continue;
      if (this.now < packet.startAt) {
        survivors.push(packet);
        continue;
      }
      packet.progress += packet.speed * ms;
      const end = packet.path.length - 1;
      if (packet.progress >= end) {
        packet.progress = end;
        packet.arrived = true;
        if (packet.dir === 'out') {
          const state = this.agents.get(packet.agentKey);
          if (state) state.flashUntil = Math.max(state.flashUntil, this.now + 220);
        } else {
          this.centerFlashUntil = Math.max(this.centerFlashUntil, this.now + 180);
        }
        continue;
      }
      survivors.push(packet);
    }
    this.packets = survivors;
  }

  /** Advance the virtual clock in small steps so packets animate smoothly. */
  advance(ms) {
    let remaining = Math.max(0, ms);
    while (remaining > 0) {
      const step = Math.min(STEP_MS, remaining);
      this.now += step;
      this._step(step);
      remaining -= step;
    }
  }

  _drawBranches() {
    for (const cell of this.showOther ? this._otherTracks : this._tracks) {
      this.canvas.put(cell.row, cell.col, cell.glyph, GRAY.gray2);
    }
    for (const [key, slot] of this._slots) {
      if (key === 'other' && !this.showOther) continue;
      const state = this.agents.get(key);
      if (state && !this.reducedMotion && state.pulseUntil > this.now) {
        const count = Math.min(6, slot.path.length);
        for (let offset = 1; offset <= count; offset += 1) {
          const cell = slot.path[slot.path.length - offset];
          const lit = (Math.floor(this.now / 110) + offset) % 2 === 0;
          this.canvas.put(cell.row, cell.col, lit ? '●' : '·', state.def.color);
        }
      }
    }
  }

  _drawActiveAgents() {
    // Need vertical room in the sky slice and horizontal room beside the
    // centered factory building; otherwise skip so the skyline stays intact.
    if (this.layout.sky.rows < 4 || this.width < 120) return;
    const width = 20;
    const maxHeight = this.layout.sky.rows;
    const working = [...this.agents.entries()].filter(([key, state]) => (
      state.status === 'working' && (key !== 'other' || this.showOther)
    ));
    const height = Math.min(maxHeight, Math.max(3, working.length + 2));
    const contentRows = height - 2;
    const style = working.length > 0 ? T.textPrimary : T.border;
    const title = `ACTIVE AGENTS (${working.length})`;
    this.canvas.fill(0, 0, width, height, ' ', 0);
    this.canvas.box(0, 0, width, height, style, title);
    // Preserve the full 17-character title inside this compact 20-cell panel.
    this.canvas.write(0, Math.max(1, Math.floor((width - displayWidth(title)) / 2)), title, style);

    if (working.length === 0) {
      const pulse = this.reducedMotion || Math.floor(this.now / 450) % 2 === 0;
      this.canvas.write(1, 2, '○ none working', pulse ? T.textSecondary : T.border);
      return;
    }

    const overflow = working.length > contentRows;
    const visibleCount = overflow ? contentRows - 1 : working.length;
    working.slice(0, visibleCount).forEach(([, state], index) => {
      this.canvas.write(1 + index, 2, truncate(`${this._spinner()} ${state.def.label.toUpperCase()}${state.workerCount > 1 ? ` ×${state.workerCount}` : ''}`, width - 4), state.def.color);
    });
    if (overflow) {
      this.canvas.write(height - 2, 2, `+${working.length - visibleCount} more`, T.textSecondary);
    }
  }

  _drawGoUsage() {
    // Need vertical room in the sky slice and horizontal room beside the
    // centered factory building; otherwise skip so the skyline stays intact.
    if (this.layout.sky.rows < 4 || this.width < 120) return;
    const width = 24;
    const col = this.width - width;
    const rolling = this.goUsage?.rolling;
    const linked = rolling && Number.isFinite(rolling.percent) && typeof rolling.resetsAt === 'string';
    const maxHeight = this.layout.sky.rows;
    const height = Math.min(maxHeight, linked ? 4 : 3);
    const percent = linked ? Math.round(rolling.percent) : 0;
    const color = !linked
      ? T.textSecondary
      : percent < 60
        ? T.success
        : percent <= 85
          ? T.warning
          : T.error;
    const title = linked ? `GO 5H ${percent}%` : 'GO 5H';
    this.canvas.fill(0, col, width, height, ' ', 0);
    this.canvas.box(0, col, width, height, color, title);

    if (!linked) {
      this.canvas.write(1, col + 2, 'usage unavailable', T.textSecondary);
      return;
    }
    const filled = Math.max(0, Math.min(10, Math.round((rolling.percent / 100) * 10)));
    const bar = `${'█'.repeat(filled)}${'░'.repeat(10 - filled)} ${percent}%`;
    this.canvas.write(1, col + 2, truncate(bar, width - 4), color);
    if (height >= 4) {
      const reset = formatReset(rolling.resetsAt, Date.now());
      this.canvas.write(2, col + 2, truncate(`resets ${reset || '--'}`, width - 4), T.textSecondary);
    }
  }

  _drawCenter() {
    const box = this.layout.center;
    const working = [...this.agents.values()].filter((state) => state.status === 'working').length;
    const total = this.showOther ? 7 : 6;
    const flash = this.centerFlashUntil > this.now;
    const style = flash ? this.centerFlashColor : ORCHESTRATOR.color;
    this.canvas.box(box.row, box.col, box.width, box.height, style, ORCHESTRATOR.label);

    if (box.height < 7) {
      this._writeHighlighted(box.row + 1, box.col + 2, `${ORCHESTRATOR.name} · ${this.workerPreview ? 'dumpling' : this.activity}`, box.width - 4);
      if (box.height >= 4) this.canvas.write(box.row + 2, box.col + 2, truncate(this.workerPreview ? 'bean / puff' : this.parallel.enabled ? this._parallelSummary() : `${working}/${total} working`, box.width - 4), T.textSecondary);
      return;
    }

    const inner = box.width - 2;
    this.canvas.write(box.row + 1, box.col + 2, truncate(`${ORCHESTRATOR.name} · ${this.orchestratorWorker.workerState}`, inner - 2), style);
    if (this.inputMode && this.centerLog.length > 0) {
      const recent = this.centerLog.slice(-2);
      recent.forEach((line, index) => {
        const style = index === recent.length - 1 ? T.textPrimary : T.textSecondary;
        this._writeHighlighted(box.row + 2 + index, box.col + 2, line, inner - 2, style);
      });
    } else {
      const dots = this.run.state === 'running' && !this.reducedMotion ? '.'.repeat((Math.floor(this.now / 450) % 3) + 1) : '';
      const lines = wrapText(`${this.activity}${dots}`, inner - 4);
      this._writeHighlighted(box.row + 2, box.col + 2, `› ${truncate(lines[0] ?? '', inner - 4)}`, inner - 2, T.textPrimary);
      this.canvas.write(box.row + 3, box.col + 2, truncate(lines[1] ?? '', inner - 2), T.textSecondary);
    }

    const spin = this._spinner();
    // The last log/activity row gives way to the parallel worker count.
    if (this.parallel?.enabled && (!this.inputMode || this.centerLog.length < 2)) {
      this.canvas.write(box.row + 3, box.col + 2, truncate(this._parallelSummary(), inner - 2), T.textSecondary);
    }
    this._writeHighlighted(
      box.row + 4,
      box.col + 2,
      `msgs ${this.totalMessages} · tools ${this.totalTools} · ${Math.round(this.totalKb)}kb`,
      inner - 2,
      GRAY.gray2,
    );
    const idlePulse = this.reducedMotion || Math.floor(this.now / 450) % 2 === 0;
    this.canvas.write(
      box.row + 5,
      box.col + 2,
      truncate(`${working ? spin : '○'} ${working}/${total} working`, inner - 2),
      working ? T.textPrimary : idlePulse ? T.textSecondary : T.border,
    );
  }

  _drawAgents() {
    for (const [key, state] of this.agents) {
      if (key === 'other' && !this.showOther) continue;
      const slot = this._slots.get(key);
      if (!slot) continue;
      const box = slot.box;
      const def = state.def;
      const label = `${def.label}${state.workerCount > 1 ? ` ×${state.workerCount}` : ''}`;
      const status = statusGlyph(state, this.reducedMotion ? 0 : this.now, this._spinner());
      const border = state.flashUntil > this.now ? T.textPrimary : state.workerState === 'failed' ? T.warning : state.status === 'idle' ? T.border : def.color;
      if (box.height < 5) {
        const workerLabel = state.workerState === 'completed' ? 'done' : state.workerState;
        this.canvas.fill(box.row, box.col, box.width, box.height);
        this.canvas.write(box.row, box.col + 2, truncate(`${status.glyph} ${def.label}`, box.width - 4), def.color);
        const name = def.name ?? def.key;
        const detail = `${name} · ${workerLabel}`;
        this.canvas.write(box.row + 1, box.col + 2, displayWidth(detail) <= box.width - 4 ? detail : name, def.color);
        if (box.height >= 3) this.canvas.write(box.row + 2, box.col + 2, truncate(state.messages.at(-1)?.text ?? def.role, box.width - 4), T.textSecondary);
        if (box.height >= 4) this.canvas.write(box.row + 3, box.col + 2, truncate(`msg:${state.messageCount} tool:${state.toolCount}`, box.width - 4), T.textSecondary);
        continue;
      }
      const shownLabel = truncate(label, box.width - 6);
      this.canvas.box(box.row, box.col, box.width, box.height, border, shownLabel);
      const titleCol = box.col + Math.max(2, Math.floor((box.width - displayWidth(shownLabel) - 2) / 2));
      this.canvas.write(box.row, titleCol, ` ${shownLabel} `, def.color);
      const inner = box.width - 2;
      const stamp = { glyph: status.glyph, color: status.color };
      this.canvas.put(box.row, box.col + box.width - 2, stamp.glyph, stamp.color);

      this.canvas.write(box.row + 1, box.col + 2, truncate(`${def.name ?? def.key} · ${state.workerState === 'completed' ? 'done' : state.workerState}`, inner - 2), def.color);
      const feedRows = Math.max(1, box.height - 4);
      const messages = state.messages.slice(-feedRows);
      for (let index = 0; index < feedRows; index += 1) {
        const message = messages[index];
        if (!message) {
          if (index === 0 && state.messageCount === 0) {
            const line = state.workerState === 'completed' ? '✓ task complete' : state.workerState === 'failed' ? '? failed · see log'
              : state.status === 'working' ? `${state.workerState} ${this._spinner()}` : `${status.glyph} waiting for task`;
            const color = state.status === 'working' ? def.color : state.workerState === 'failed' ? T.warning : T.textSecondary;
            this.canvas.write(box.row + 2, box.col + 2, truncate(line, inner - 2), color);
          }
          continue;
        }
        const prefix = message.dir === 'out' ? '»' : '«';
        this.canvas.put(box.row + 2 + index, box.col + 2, prefix, def.color);
        this._writeHighlighted(box.row + 2 + index, box.col + 4, message.text, inner - 4, T.textPrimary);
      }

      const sessions = state.sessions > 1 ? ` · ${state.sessions} sess` : '';
      this.canvas.write(
        box.row + box.height - 2,
        box.col + 2,
        truncate(`msg:${state.messageCount} tool:${state.toolCount}${sessions}`, inner - 2),
        T.textSecondary,
      );
    }
  }

  _drawPackets() {
    if (this.reducedMotion) return;
    for (const packet of this.packets) {
      if (this.now < packet.startAt) continue;
      const index = Math.min(packet.path.length - 1, Math.max(0, Math.floor(packet.progress)));
      const cell = packet.path[index];
      const glyph = packet.size >= 3 ? '●' : packet.size === 2 ? '◐' : '·';
      this.canvas.put(cell.row, cell.col, glyph, packet.color);
      const trail = packet.path[index - 1];
      if (trail) this.canvas.put(trail.row, trail.col, '·', packet.color);
      // One little node per KB: trail behind the head, spread to fit the path.
      const count = Math.max(0, (packet.nodes ?? 1) - 1);
      if (count > 0) {
        const span = Math.min(2, Math.max(1, Math.floor((index) / Math.max(1, count + 1))));
        for (let node = 1; node <= count; node += 1) {
          const nodeIndex = index - node * span;
          if (nodeIndex < 0) break;
          const nodeCell = packet.path[nodeIndex];
          this.canvas.put(nodeCell.row, nodeCell.col, '·', packet.color);
        }
      }
    }
  }

  _drawPorts() {
    const center = this.layout.center;
    for (const [key, slot] of this._slots) {
      if (key === 'other' && !this.showOther) continue;
      for (const path of [slot.path, slot.returnPath]) {
        const source = path[0], target = path.at(-1);
        const sourceGlyph = source.row === center.row + center.height - 1 ? '┬' : source.col === center.col ? '┤' : '├';
        this.canvas.put(source.row, source.col, sourceGlyph, GRAY.gray2);
        this.canvas.put(target.row, target.col, target.col === slot.box.col ? '┤' : '├', GRAY.gray2);
      }
    }
  }

  _drawInput() {
    if (this.layout.inputRow == null) return;
    const rows = this.layout.inputRows ?? [this.layout.inputRow];
    for (const row of rows) this.canvas.fill(row, 0, this.width, 1, ' ', 0);
    const row = rows[0];
    const prompt = 'task> ';
    const promptCol = 1 + prompt.length;
    const inner = Math.max(1, this.width - promptCol - 2);
    this.canvas.write(row, 1, prompt, this.run.state === 'running' ? T.textSecondary : ORCHESTRATOR.color);
    if (!this.inputValue) {
      this.canvas.write(row, promptCol + 2, truncate('type a task and press enter', Math.max(1, inner - 2)), T.border);
      this.canvas.put(row, promptCol, '▌', T.textPrimary);
      return;
    }
    // Preserve whitespace and follow the real caret, including wide glyphs.
    // Pasted lines stay collapsed; editing an earlier line reveals that line.
    const all = this.inputValue.replace(/\r\n|\r/g, '\n').split('\n');
    const before = Array.from(this.inputValue).slice(0, this.inputCursor).join('').replace(/\r\n|\r/g, '\n').split('\n');
    const total = all.length;
    const currentLine = all[before.length - 1] ?? '';
    const prefix = total > 1 ? `[pasted ${total} lines] ` : '';
    const chars = Array.from(stripAnsi(prefix + currentLine));
    const caret = Array.from(stripAnsi(prefix + before.at(-1))).length;
    const lines = [''];
    let used = 0;
    let cursorPoint = { row: 0, col: 0 };
    for (let index = 0; index <= chars.length; index++) {
      const glyph = chars[index];
      const cells = glyph ? charWidth(glyph) : 0;
      if (used + cells > inner - 1) { lines.push(''); used = 0; }
      if (index === caret) cursorPoint = { row: lines.length - 1, col: used };
      if (!glyph) break;
      lines[lines.length - 1] += glyph;
      used += cells;
    }
    const start = Math.max(0, Math.min(cursorPoint.row, lines.length - rows.length));
    const visible = lines.slice(start, start + rows.length);
    visible.forEach((line, index) => {
      const row = rows[index];
      const marker = prefix.trimEnd(); // '[pasted N lines]'
      if (prefix && line.startsWith(marker)) {
        const rest = line.slice(marker.length);
        const afterMarker = this.canvas.write(row, promptCol, marker, GRAY.yellow);
        this.canvas.write(row, afterMarker, rest, T.textPrimary);
      } else {
        this.canvas.write(row, promptCol, line, T.textPrimary);
      }
    });
    this.canvas.put(rows[cursorPoint.row - start], promptCol + cursorPoint.col, '▌', T.textPrimary);
  }

  _drawStatus() {
    const idleTaskHint = this.run.state === 'running'
      ? ' · esc abort · /log log · Enter×2 steer'
      : ' · /sessions pick · /new fresh · /log log';
    const sessionSuffix = this.sessionID ? ` · session ${this.sessionID}` : '';
    const prefix = this.factoryPreview ? `Factory preview · ${this._parallelSummary()} · q quit` : this.workerPreview ? 'Worker audition · dumpling (selected) / bean / puff · q quit' : this.inputMode
      ? `theFactory · task · ${this._runStatusLine()}${idleTaskHint}${sessionSuffix}`
      : `theFactory · ${this.mode} · ${this.totalMessages} msgs · ${this.packets.length} packet(s) · q quit${sessionSuffix}`;
    const statusColor = !this.inputMode
      ? T.textSecondary
      : this.run.state === 'error'
        ? T.error
        : this.run.state === 'done'
          ? T.success
          : T.textSecondary;
    const right = `${this.width}×${this.height}`;
    const rightCol = this.width - right.length - 1;
    let compactPrefix = this.inputMode && this.width < 100 && !this.workerPreview
      ? this.run.state === 'error' ? `failed · /log logs · ${this.run.detail}`
        : `${this.run.state === 'running' ? `running · ${this.runElapsedSeconds()}s · Esc abort` : this.run.state === 'done' ? '✓ task complete' : 'ready · Enter run'} · /log logs`
      : prefix;
    if (!this.workerPreview && (this.inputMode || this.factoryPreview || this.run.state !== 'idle')) {
      const progress = this.getPromptProgress();
      const bar = progressBar(progress, this.width < 100 ? 8 : 12, { now: this.now, reducedMotion: this.reducedMotion });
      const controls = !this.inputMode ? 'q quit' : this.run.state === 'running' ? 'Esc abort · /log logs' : this.completionOverview ? '/overview · /log logs' : 'Enter run · /log logs';
      const brand = this.factoryPreview ? 'Factory preview · ' : this.width >= 100 ? 'theFactory · ' : '';
      compactPrefix = `${brand}${bar} ${progress.label} · ${controls}`;
    }
    this.canvas.write(this.layout.statusRow, 1, truncate(compactPrefix, rightCol - 2), statusColor);
    this.canvas.write(this.layout.statusRow, rightCol, right, T.textSecondary);
    if (this.inputMode) this._drawInput();
  }

  /** Paint the log overlay on top of everything (only when open). */
  _drawLog() {
    if (!this.logView.open) return;
    this.canvas.clear();
    const boxWidth = this.width - 4;
    const boxHeight = this.height - 4;
    const row = Math.max(1, Math.floor((this.height - boxHeight) / 2));
    const col = Math.max(1, Math.floor((this.width - boxWidth) / 2));
    const key = this.logView.agentKey;
    const label = key === 'orchestrator'
      ? ORCHESTRATOR.label
      : (this.agents.get(key)?.def.label ?? key.toUpperCase());
    const entries = this._logEntries();
    const live = this.run.state === 'running'
      || [...this.agents.values()].some((state) => state.status === 'working');
    const following = !this.logView.paused && this.logView.scroll === 0;
    const liveMarker = live && following ? 'LIVE' : following ? 'LATEST' : 'PAUSED';
    const runtime = this.agentRuntime.get(key) ?? {};
    const settings = this.configView.info;
    const model = runtime.model ?? settings.agentModels?.[key] ?? settings.model ?? '(OpenCode default)';
    const agent = this.agents.get(key);
    const state = key === 'orchestrator' ? this.run.state : agent?.workerState === 'failed' ? 'failed' : agent?.status ?? 'idle';
    const session = runtime.sessionID ?? this.sessionID ?? this.run.sessionID;
    // Clear the overlay so the underlying frame does not bleed through.
    this.canvas.fill(row, col, boxWidth, boxHeight, ' ', 0);
    const overview = Boolean(this.logView.overview);
    this.canvas.box(row, col, boxWidth, boxHeight, key === 'orchestrator' ? ORCHESTRATOR.color : this.agents.get(key)?.def.color ?? T.border, `${overview ? 'OVERVIEW' : 'LOG'}: ${label}`);
    this.canvas.write(
      row + 1,
      col + 2,
      truncate(overview ? `${progressBar(this.getPromptProgress(), 8)} ${this.getPromptProgress().label} · ${state}` : `${entries.length} entries · ${this.logView.filter.toUpperCase()} · ${liveMarker} · ${state}`, boxWidth - 4),
      T.textSecondary,
    );
    if (!overview) {
      this.canvas.write(row + 2, col + 2, truncate(`model ${model}`, boxWidth - 4), T.info);
      this.canvas.write(row + 3, col + 2, truncate(session ? `session ${session}` : 'Session starts with the next task', boxWidth - 4), T.textSecondary);
    }
    const visibleRows = Math.max(1, boxHeight - (overview ? 4 : 6));
    const lines = this._logRows(visibleRows);
    lines.forEach((line, index) => {
      let cursor = col + 2;
      for (const segment of line.segments) cursor = this.canvas.write(row + (overview ? 2 : 4) + index, cursor, segment.text, segment.style);
    });
    if (lines.length === 0) {
      this.canvas.write(row + 4, col + 2, truncate(`No ${this.logView.filter === 'all' ? 'events yet. Run a task to see activity.' : `${this.logView.filter}. Press f to change the filter.`}`, boxWidth - 4), T.textSecondary);
    }
    const help = overview ? '↑/↓ scroll · PgUp/Dn · g/G top/end · Esc close' : this.width >= 100
      ? '←/→ agent · ↑/↓ scroll · PgUp/Dn · f filter · g/G top/latest · space pause · esc close'
      : '←/→ agent  ↑/↓ scroll  f filter  G latest  esc close';
    this.canvas.write(row + boxHeight - 2, col + 2, truncate(help, boxWidth - 4), T.textSecondary);
  }

  /** Paint the config overlay on top of everything (only when open). */
  _drawConfig() {
    if (!this.configView.open) return;
    if (this.modelPicker.open) { this._drawModelPicker(); return; }
    this.canvas.clear();
    const info = this.configView.info ?? {};
    const values = {
      model: info.model || '(default)',
      profile: info.profile === 'custom' ? `custom (${info.customBaseProfile || 'default'})` : info.profile || '(default)',
      verbose: info.verbosity ? info.verbosity.toUpperCase() : '(default)',
      autoFallback: info.autoFallback ? `ON (${(info.fallbackModels || []).length} models)` : 'OFF',
      auto: info.auto ? 'ON' : 'OFF',
      parallel: info.parallel ? `${info.workers || 3} workers` : 'OFF',
      sequential: info.sequential ? 'ON' : 'OFF',
      nolimit: info.nolimit ? 'ON' : 'OFF',
      graphify: info.graphify ? 'ON' : 'OFF',
      volume: info.volume == null ? '(default)' : (info.volume === 0 ? 'muted (0)' : `${info.volume}%`),
      dir: info.dir || process.cwd(),
      session: info.session || '(new on next task)',
    };
    for (const agent of ['orchestrator', ...AGENT_ORDER]) {
      values[`agent:${agent}`] = info.effectiveAgentModels?.[agent]
        || info.agentModels?.[agent] || '(shared/default)';
    }
    const labelWidth = Math.max(...CONFIG_ROWS.map((row) => row.label.length));
    const lines = CONFIG_ROWS.map((row) => {
      const cursor = row.key === this.configView.selected ? '›' : ' ';
      const suffix = row.editable ? '' : '  (read-only)';
      return `${cursor} ${row.label.padEnd(labelWidth)}  ${values[row.key]}${suffix}`;
    });
    const boxWidth = Math.max(36, Math.min(this.width - 4, Math.max(...lines.map((line) => line.length)) + 6));
    const boxHeight = Math.min(this.height - 2, lines.length + 4);
    const visibleRows = Math.max(1, boxHeight - 4);
    const selectedIndex = CONFIG_ROWS.findIndex((def) => def.key === this.configView.selected);
    let scroll = this.configView.scroll;
    if (selectedIndex < scroll) scroll = selectedIndex;
    if (selectedIndex >= scroll + visibleRows) scroll = selectedIndex - visibleRows + 1;
    if (selectedIndex === CONFIG_ROWS.findLastIndex((def) => def.editable)) scroll = Math.max(0, lines.length - visibleRows);
    scroll = Math.max(0, Math.min(scroll, lines.length - visibleRows));
    this.configView.scroll = scroll;
    const row = Math.max(1, Math.floor((this.height - boxHeight) / 2));
    const col = Math.max(1, Math.floor((this.width - boxWidth) / 2));
    // Clear the overlay so the underlying frame does not bleed through.
    this.canvas.fill(row, col, boxWidth, boxHeight, ' ', 0);
    this.canvas.box(row, col, boxWidth, boxHeight, T.border, 'theFactory Configuration');
    this.canvas.write(
      row + 1,
      col + 2,
      truncate('↑/↓ row · enter models · ←/→ cycle · esc close', boxWidth - 4),
      T.textSecondary,
    );
    lines.slice(scroll, scroll + visibleRows).forEach((line, index) => {
      const def = CONFIG_ROWS[scroll + index];
      const selected = def.key === this.configView.selected;
      const color = !def.editable
        ? T.textMuted
        : selected
          ? T.textPrimary
          : T.textSecondary;
      const prefix = `${selected ? '›' : ' '} ${def.label.padEnd(labelWidth)}  `;
      const value = `${values[def.key]}${def.editable ? '' : ' (read-only)'}`;
      this.canvas.write(row + 2 + index, col + 2, prefix, color);
      this.canvas.write(row + 2 + index, col + 2 + displayWidth(prefix), truncate(value, boxWidth - 4 - displayWidth(prefix)), color);
    });
    const scope = this.configView.selected === 'model' ? 'Changes ALL agents' : this.configView.selected.startsWith('agent:') ? `${this.configView.selected.slice(6)} only` : 'Saved · next task';
    this.canvas.write(row + boxHeight - 2, col + 2, truncate(`Rows ${scroll + 1}-${Math.min(lines.length, scroll + visibleRows)}/${lines.length} · ${scope}`, boxWidth - 4), T.textSecondary);
  }

  _drawModelPicker() {
    this.canvas.clear();
    const picker = this.modelPicker;
    const width = Math.min(this.width - 4, 78);
    const height = Math.min(this.height - 2, picker.models.length + 4);
    const visible = Math.max(1, height - 4);
    const hasCoarena = picker.models.some((model) => model?.startsWith('coarena-'));
    let pinned = 0;
    if (hasCoarena) {
      while (pinned < picker.models.length && (picker.models[pinned] === null || picker.models[pinned]?.startsWith('coarena-'))) pinned += 1;
    }
    const divider = pinned > 0 && pinned < picker.models.length ? 1 : 0;
    const catalogRows = Math.max(1, visible - pinned - divider);
    if (picker.selected >= pinned) {
      const selected = picker.selected - pinned;
      if (selected < picker.scroll) picker.scroll = selected;
      if (selected >= picker.scroll + catalogRows) picker.scroll = selected - catalogRows + 1;
    }
    picker.scroll = Math.max(0, Math.min(picker.scroll, picker.models.length - pinned - catalogRows));
    const row = Math.max(1, Math.floor((this.height - height) / 2));
    const col = Math.floor((this.width - width) / 2);
    const target = picker.key === 'model' ? 'ALL AGENTS' : picker.key.slice(6).toUpperCase();
    this.canvas.box(row, col, width, height, T.border, `Base model: ${target}`);
    const help = hasCoarena ? '↑/↓ choose · C Coarena · enter apply · esc cancel' : '↑/↓ choose · enter apply · esc cancel';
    this.canvas.write(row + 1, col + 2, truncate(help, width - 4), T.textSecondary);
    const drawModel = (modelIndex, offset) => {
      const model = picker.models[modelIndex];
      const selected = modelIndex === picker.selected;
      const label = model ?? 'Use the all-agent model';
      this.canvas.write(row + 2 + offset, col + 2, selected ? '› ' : '  ', T.textPrimary);
      this.canvas.write(row + 2 + offset, col + 4, truncate(label, width - 6), selected ? T.textPrimary : model?.startsWith('coarena-') ? T.info : T.textSecondary);
    };
    for (let index = 0; index < pinned; index += 1) drawModel(index, index);
    if (divider) this.canvas.write(row + 2 + pinned, col + 2, '─'.repeat(width - 4), T.border);
    const start = pinned + picker.scroll;
    const end = Math.min(picker.models.length, start + catalogRows);
    for (let index = start; index < end; index += 1) drawModel(index, pinned + divider + index - start);
    const scope = picker.key === 'model' ? 'Applies to all seven agents' : `Only ${picker.key.slice(6)} will change`;
    this.canvas.write(row + height - 2, col + 2, truncate(`${picker.selected + 1}/${picker.models.length} · ${scope}`, width - 4), T.textSecondary);
  }

  /** Paint the most recently detected image (Apple Terminal shows its path). */
  _drawImage() {
    if (!this.imageView.open || !this.imageView.image) return;
    const image = this.imageView.image;
    const target = image.path ?? image.url ?? image.uri ?? '(unknown target)';
    const lines = [
      { text: image.name || 'image', color: T.textPrimary },
      { text: `mime: ${image.mime || 'unknown'}`, color: T.textSecondary },
      { text: String(target), color: T.textSecondary },
      { text: 'o open externally · esc close', color: T.textPrimary },
    ];
    const boxWidth = Math.min(
      this.width - 4,
      Math.max(40, Math.min(76, Math.max(...lines.map((line) => line.text.length)) + 6)),
    );
    const boxHeight = lines.length + 2;
    const row = Math.max(1, Math.floor((this.height - boxHeight) / 2));
    const col = Math.max(1, Math.floor((this.width - boxWidth) / 2));
    this.canvas.fill(row, col, boxWidth, boxHeight, ' ', 0);
    this.canvas.box(row, col, boxWidth, boxHeight, T.textPrimary, 'IMAGE');
    lines.forEach((line, index) => {
      this.canvas.write(row + 1 + index, col + 2, truncate(line.text, boxWidth - 4), line.color);
    });
  }

  /** Paint the pending OpenCode question form above every other overlay. */
  _drawQuestion() {
    if (!this.questionView.open) return;
    const state = this.questionView;
    const field = currentField(state);
    if (!field) return;
    const options = fieldOptions(state);
    const body = [];
    const progress = state.fields.length > 1 ? ` · field ${state.fieldIndex + 1}/${state.fields.length}` : '';
    body.push({ text: `${state.form?.title || 'OpenCode question'}${progress}`, color: T.textPrimary });
    body.push({ text: field.title || field.key || field.type || 'Question', color: T.textPrimary });
    if (field.description) body.push({ text: String(field.description), color: T.textSecondary });

    options.forEach((option, index) => {
      const cursor = index === state.optionIndex && !state.custom ? '›' : ' ';
      const checkbox = field.type === 'multiselect'
        ? `${state.selected?.includes(option.value) ? '[x]' : '[ ]'} `
        : '';
      const description = option.description ? ` — ${option.description}` : '';
      body.push({
        text: `${cursor} ${checkbox}${option.label ?? option.value}${description}`,
        color: index === state.optionIndex && !state.custom ? T.textPrimary : T.textSecondary,
      });
    });

    const customRow = options.length > 0 && (field.custom === true || field.type === 'string');
    if (customRow) {
      body.push({
        text: `${state.custom ? '›' : ' '} your answer: ${state.buffer}${state.custom ? '▌' : ''}`,
        color: state.custom ? T.textPrimary : T.textSecondary,
      });
    } else if (options.length === 0 && ['string', 'number', 'integer'].includes(field.type)) {
      body.push({ text: `answer: ${state.buffer}▌`, color: T.textPrimary });
    }

    if (field.type === 'boolean') {
      body.push({ text: `value: ${state.buffer} · y/n/space/←/→`, color: T.textPrimary });
    } else if (field.type === 'multiselect') {
      body.push({ text: 'space toggle selected options', color: T.textSecondary });
    } else if (field.type === 'external') {
      body.push({ text: `${field.url ?? field.uri ?? field.href ?? ''} · o open externally`, color: T.textSecondary });
    }

    const hint = '↑/↓ choose · ↵ submit · esc cancel · type for your own answer';
    const allLines = [...body, ...(state.error ? [{ text: state.error, color: T.error }] : []), { text: hint, color: T.textPrimary }];
    const boxWidth = Math.min(
      this.width - 4,
      Math.max(44, Math.min(78, Math.max(...allLines.map((line) => line.text.length)) + 6)),
    );
    const boxHeight = Math.min(this.height - 4, allLines.length + 2);
    const row = Math.max(1, Math.floor((this.height - boxHeight) / 2));
    const col = Math.max(1, Math.floor((this.width - boxWidth) / 2));
    this.canvas.fill(row, col, boxWidth, boxHeight, ' ', 0);
    this.canvas.box(row, col, boxWidth, boxHeight, T.textPrimary, 'QUESTION');

    const contentRows = boxHeight - 2;
    const extraRows = 1 + (state.error ? 1 : 0);
    const visibleBody = body.slice(0, Math.max(0, contentRows - extraRows));
    const lines = [...visibleBody, ...(state.error ? [{ text: state.error, color: T.error }] : []), { text: hint, color: T.textPrimary }];
    lines.slice(0, contentRows).forEach((line, index) => {
      this.canvas.write(row + 1 + index, col + 2, truncate(line.text, boxWidth - 4), line.color);
    });
  }

  /** Paint a compact session id/title header at the very top of the frame. */
  _drawSessionHeader() {
    if (!this.sessionID || this.layout.sky.rows < 1) return;
    const title = this.sessionTitle ? ` · ${this.sessionTitle}` : '';
    const text = `session: ${this.sessionID}${title}`;
    // Keep clear of the ACTIVE AGENTS panel (left) and GO usage panel (right).
    const hasPanels = this.width >= 120 && this.layout.sky.rows >= 4;
    const leftPad = hasPanels ? 22 : 1;
    const rightPad = hasPanels ? 26 : 1;
    const factory = factoryGeometry(this);
    const artLeft = factory?.tiny ? Math.floor((this.width - 16) / 2) : factory?.col;
    const artRight = factory?.tiny ? artLeft + 16 : factory?.signCol + 31;
    const spans = [[leftPad, artLeft - 1], [artRight + 1, this.width - rightPad]];
    const [start, end] = spans.sort((a, b) => (b[1] - b[0]) - (a[1] - a[0]))[0];
    const maxWidth = Math.max(0, end - start);
    if (maxWidth < 8) return;
    const shown = truncate(maxWidth < 32 ? `session ${this.sessionID.slice(0, 12)}` : text, maxWidth);
    if (!shown) return;
    const col = start;
    // Clear the strip behind the text so the skyline doesn't bleed through.
    this.canvas.fill(0, col, shown.length, 1, ' ', 0);
    this.canvas.write(0, col, shown, T.textSecondary);
  }

  _workerDesign(slot) {
    return this.workerPreview ? WORKER_DESIGNS[['top', 'middle', 'bottom'].indexOf(slot?.band)] ?? 'dumpling' : 'dumpling';
  }

  _drawWorkers() {
    const paint = (area, state, key, color, design = 'dumpling') => {
      if (!area) return;
      this.canvas.fill(area.row, area.col, area.width, area.height);
      const elapsed = this.now - state.workerSince;
      drawWorker(this.canvas, area, { key, color, design, state: state.workerState, elapsed: this.workerPreview && state.workerState === 'completed' ? elapsed % 1800 : elapsed, reducedMotion: this.reducedMotion });
    };
    paint(this.layout.centerWorker, this.orchestratorWorker, 'orchestrator', ORCHESTRATOR.color);
    for (const [key, state] of this.agents) {
      if (key === 'other' && !this.showOther) continue;
      const slot = this._slots.get(key);
      if (slot) paint(slot.worker, state, key, state.def.color, this._workerDesign(slot));
    }
  }
  /** Paint the current state into the back buffer. */
  draw() {
    this.canvas.clear();
    if (this.layout.tooSmall) {
      this.canvas.write(0, 0, truncate('Terminal too small', this.width), T.warning);
      if (this.height > 1) this.canvas.write(1, 0, truncate(`Resize to 60×24 · now ${this.width}×${this.height}`, this.width), T.textPrimary);
      if (this.height > 2) this.canvas.write(2, 0, truncate(this.run.state === 'running' ? 'Task continues · Ctrl-C quits' : 'Ctrl-C quits', this.width), T.textSecondary);
      return;
    }
    if (this.logView.open || this.configView.open || this.imageView.open || this.questionView.open) {
      this._drawLog();
      this._drawConfig();
      this._drawImage();
      this._drawQuestion();
      return;
    }
    // theFactory skyline: baked first so overlays cover it; animated whenever
    // agents are working (src hook -> workin_on/factory.js).
    drawFactory(this);
    this._drawBranches();
    this._drawActiveAgents();
    this._drawGoUsage();
    this._drawSessionHeader();
    this._drawCenter();
    this._drawAgents();
    this._drawWorkers();
    this._drawPorts();
    this._drawPackets();
    this._drawStatus();
    this._drawLog();
    this._drawConfig();
    this._drawImage();
    this._drawQuestion();
  }

  /** Paint and return the diffed ANSI frame. */
  frame() {
    this.draw();
    return this.canvas.flush();
  }

  /** Paint and return a colour-free text frame. */
  snapshot() {
    this.draw();
    return this.canvas.toPlainText();
  }
}

export { AGENTS, PACKET_SPEED };
