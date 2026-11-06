/**
 * Visualizer state machine: consumes agent events, animates packets along
 * branch paths, and paints frames into a diffed character canvas.
 */

import { AGENTS, AGENT_ORDER, ORCHESTRATOR, agentByKey, resolveAgent } from './agents.js';
import { Canvas, truncate, wrapText } from './canvas.js';
import { themeFor, APPLE_UIKIT } from './colors.js';
import { buildLayout } from './layout.js';
import { drawFactory } from '../workin_on/factory.js';

const T = themeFor('dark'); // terminalThemes.dark tokens (exact JSON hex)
const GRAY = APPLE_UIKIT.dark.system;

const PACKET_SPEED = 0.018; // cells per millisecond
const STEP_MS = 16;

/** Config overlay rows in display order; editable rows respond to enter/arrows. */
const CONFIG_ROWS = [
  { key: 'model', label: 'model', editable: true },
  { key: 'fallbacks', label: 'fallbacks', editable: true },
  { key: 'auto', label: 'auto', editable: true },
  { key: 'parallel', label: 'parallel', editable: true },
  { key: 'sequential', label: 'sequential', editable: true },
  { key: 'nolimit', label: 'nolimit', editable: true },
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
    flashUntil: 0,
    pulseUntil: 0,
  };
}

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function statusGlyph(state, now) {
  if (state.status === 'done') return { glyph: '✓', color: T.success };
  if (state.status === 'working') return { glyph: '●', color: state.def.color };
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
    this.footerRows = this.inputMode ? 2 : 1;
    this.canvas = new Canvas(this.width, this.height, { color: this.color });
    this.layout = buildLayout(this.width, this.height, { footerRows: this.footerRows });
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
    this.activity = 'awaiting first task…';
    this.centerFlashUntil = 0;
    this.centerFlashColor = T.textPrimary;
    this.centerLog = [];
    this.logView = { open: false, agentKey: 'orchestrator', scroll: 0 };
    this.configView = { open: false, selected: 'model', info: {} };
    this.inputValue = '';
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
      workers: [
        // { workerId, taskId, role, sessionId, state }
      ],
      counts: { queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0 },
    };
  }

  _indexSlots() {
    this._slots = new Map();
    if (!this.layout.tooSmall) {
      for (const slot of this.layout.agents) this._slots.set(slot.key, slot);
      this._slots.set('other', this.layout.other);
    }
  }

  /** Resize the canvas and rebuild radial geometry. Returns false below 60x24. */
  resize(width, height) {
    this.width = width;
    this.height = height;
    this.canvas.resize(width, height);
    this.layout = buildLayout(width, height, { footerRows: this.footerRows });
    this._indexSlots();
    return !this.layout.tooSmall;
  }

  get tooSmall() {
    return Boolean(this.layout.tooSmall);
  }

  /** Update the live-session subtitle count for an agent pillar. */
  setSessionCount(key, count) {
    const state = this.agents.get(key);
    if (state) state.sessions = Math.max(1, count | 0);
  }

  /** Keep a small orchestrator log (20 entries max) for task mode. */
  addLog(text) {
    const line = clean(text);
    if (!line) return;
    this.centerLog.push(line);
    if (this.centerLog.length > 20) this.centerLog.shift();
  }

  /** Open the per-agent log overlay for the given agent key. */
  openLog(agentKey = 'orchestrator') {
    const key = agentKey === 'orchestrator' ? 'orchestrator' : this._agentKey(agentKey);
    this.logView.open = true;
    this.logView.agentKey = key;
    this.logView.scroll = 0;
  }

  /** Close the log overlay. */
  closeLog() {
    this.logView.open = false;
  }

  /** Open the config overlay with a snapshot of the current settings. */
  openConfig(info = {}) {
    this.configView.info = { ...info };
    this.configView.selected = 'model';
    this.configView.open = true;
  }

  /** Update the config overlay's settings snapshot without opening/closing it. */
  updateConfigInfo(info = {}) {
    if (!this.configView.open) return;
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
  }

  /** Cycle through orchestrator + 6 pillars + other. dir is ±1. */
  cycleLogAgent(dir) {
    const order = ['orchestrator', ...AGENT_ORDER, 'other'];
    let index = order.indexOf(this.logView.agentKey);
    if (index < 0) index = 0;
    const next = (index + (dir < 0 ? -1 : 1) + order.length) % order.length;
    this.logView.agentKey = order[next];
    this.logView.scroll = 0;
  }

  /** Scroll the log overlay by delta lines (negative = toward the bottom). */
  scrollLog(delta) {
    // scroll = how many entries up from the newest (0 shows latest at bottom).
    this.logView.scroll = Math.max(0, (this.logView.scroll | 0) - Math.trunc(delta));
  }

  /** Entries for the selected log-view agent (orchestrator uses centerLog). */
  _logEntries() {
    const key = this.logView.agentKey;
    if (key === 'orchestrator') {
      const entries = [...this.centerLog];
      if (this.activity) entries.push(this.activity);
      return entries;
    }
    const state = this.agents.get(key);
    return state ? state.history.map((entry) => `${entry.dir} ${entry.text}`) : [];
  }

  /** Visible log lines for the overlay (shared by _drawLog and tests). */
  _logLines(visibleRows) {
    const entries = this._logEntries();
    const maxScroll = Math.max(0, entries.length - Math.max(1, visibleRows));
    const scroll = Math.min(this.logView.scroll, maxScroll);
    this.logView.scroll = scroll;
    const end = entries.length - scroll;
    const start = Math.max(0, end - Math.max(1, visibleRows));
    return entries.slice(start, end);
  }

  /** Set the current composer value; the block cursor always sits at the end. */
  setInputValue(value) {
    this.inputValue = String(value ?? '');
  }

  /** Enter the running state for a spawned task. */
  startRun({ pid = null, sessionID = null, resumed = false, parallel = null } = {}) {
    this.run = {
      state: 'running',
      pid,
      sessionID,
      resumed: Boolean(resumed),
      parallel: parallel && typeof parallel === 'object' ? { workers: parallel.workers ?? null } : null,
      startedAt: this.now,
      duration: 0,
      detail: '',
    };
    this.activity = resumed ? 'continuing session…' : 'running task…';
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
    this.parallel.workers = Array.isArray(workers) ? workers.slice(0, 12) : [];
    const counts = { queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0 };
    for (const w of this.parallel.workers) {
      if (w.state && counts[w.state] !== undefined) counts[w.state] += 1;
    }
    this.parallel.counts = counts;
    return counts;
  }

  setParallelEnabled(enabled) {
    this.parallel.enabled = Boolean(enabled);
  }

  runElapsedSeconds() {
    if (this.run.state === 'running') return Math.max(0, Math.floor((this.now - this.run.startedAt) / 1000));
    return Math.max(0, Math.floor(this.run.duration / 1000));
  }

  /** Mark the current run done, aborted or failed. */
  finishRun(state, detail = '') {
    const duration = this.run.startedAt ? Math.max(0, this.now - this.run.startedAt) : 0;
    this.run = { ...this.run, state, duration, detail: clean(detail) };
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
    if (state.messages.length > 2) state.messages.shift();
    state.messageCount += 1;
  }

  /** Append one entry to an agent's full history (cap 500). */
  _pushHistory(state, entry) {
    if (!state) return;
    state.history.push(entry);
    if (state.history.length > 500) state.history.shift();
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
    this._pushHistory(state, { dir, text, kind: 'msg', at: this.now });
    this.totalMessages += 1;
    this.totalTokens += Math.max(1, Math.ceil(text.length / 4));
    // Real payload size in bytes drives the KB node count downstream.
    const bytes = event.bytes ?? Buffer.byteLength(text, 'utf8');
    state.status = 'working';

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
      const detail = clean(event.text);
      this.totalTools += 1;
      this.totalKb += 1;
      this.centerFlashUntil = this.now + 220;
      this.activity = `tool: ${detail || 'running tool'}`;
      if (!event.fanout) return;
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
    state.toolCount += 1;
    state.status = 'working';
    state.pulseUntil = this.now + 1000;
    this.totalTools += 1;
    this.totalKb += 1;
    const detail = clean(event.text);
    this._pushHistory(state, { dir: 'tool', text: detail || 'running tool', kind: 'tool', at: this.now });
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
      if (text) this.activity = text;
      this.centerFlashUntil = this.now + 180;
      if (text) this.addLog(text);
      return;
    }
    const key = this._agentKey(event.from);
    const state = this.agents.get(key);
    if (!state) return;
    if (key === 'other') this.showOther = true;
    if (text) this._pushHistory(state, { dir: 'status', text, kind: 'status', at: this.now });
    const lowered = text.toLowerCase();
    if (lowered.includes('done') || lowered.includes('complete') || lowered.includes('finish') || event.state === 'done') {
      state.status = 'done';
      state.flashUntil = this.now + 500;
    } else if (lowered.includes('idle') || event.state === 'idle') {
      state.status = 'idle';
    } else {
      state.status = 'working';
    }
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
    for (const [key, slot] of this._slots) {
      if (key === 'other' && !this.showOther) continue;
      // Two-way flux: one lane going out, one coming back.
      for (const path of [slot.path, slot.returnPath]) {
        for (let index = 0; index < path.length; index += 1) {
          const cell = path[index];
          const prev = path[index - 1];
          const next = path[index + 1];
          let glyph = '─';
          if (prev && next) {
            if (prev.row === cell.row && next.row === cell.row) glyph = '─';
            else if (prev.col === cell.col && next.col === cell.col) glyph = '│';
            else glyph = '+';
          } else if (next) {
            glyph = next.row === cell.row ? '─' : '│';
          } else if (prev) {
            glyph = prev.row === cell.row ? '─' : '│';
          }
          this.canvas.put(cell.row, cell.col, glyph, T.border);
        }
      }

      const state = this.agents.get(key);
      if (state && state.pulseUntil > this.now) {
        const count = Math.min(6, slot.path.length);
        for (let offset = 1; offset <= count; offset += 1) {
          const cell = slot.path[slot.path.length - offset];
          const lit = (Math.floor(this.now / 110) + offset) % 2 === 0;
          this.canvas.put(cell.row, cell.col, lit ? '●' : '·', state.def.color);
        }
      }
    }
  }

  _drawCenter() {
    const box = this.layout.center;
    const flash = this.centerFlashUntil > this.now;
    const style = flash ? this.centerFlashColor : ORCHESTRATOR.color;
    this.canvas.box(box.row, box.col, box.width, box.height, style, ORCHESTRATOR.label);

    const inner = box.width - 2;
    if (this.inputMode && this.centerLog.length > 0) {
      const recent = this.centerLog.slice(-3);
      recent.forEach((line, index) => {
        const style = index === recent.length - 1 ? T.textPrimary : T.textSecondary;
        this.canvas.write(box.row + 1 + index, box.col + 2, truncate(line, inner - 2), style);
      });
    } else {
      const lines = wrapText(this.activity, inner - 4);
      this.canvas.write(box.row + 1, box.col + 2, `› ${truncate(lines[0] ?? '', inner - 4)}`, T.textPrimary);
      this.canvas.write(box.row + 2, box.col + 2, truncate(lines[1] ?? '', inner - 2), T.textSecondary);
    }

    const working = [...this.agents.values()].filter((state) => state.status === 'working').length;
    const spin = ['◐', '◓', '◑', '◒'][Math.floor(this.now / 180) % 4];
    // Row 3 hosts the real parallel worker list when enabled (inputMode log
    // uses rows 1-3 for logs, so only draw when not colliding with 3 log lines).
    if (this.parallel?.enabled && (!this.inputMode || this.centerLog.length < 3)) {
      const list = (this.parallel.workers ?? []).slice(0, 2).map((w) => `${w.role ?? '?'}:${w.taskId ?? '?'} ${w.state ?? '?'}`).join(' · ');
      const extra = this.parallel.workers.length > 2 ? ` · +${this.parallel.workers.length - 2}w` : '';
      this.canvas.write(box.row + 3, box.col + 2, truncate(list ? `workers: ${list}${extra}` : 'workers: none', inner - 2), T.textSecondary);
    }
    this.canvas.write(
      box.row + 4,
      box.col + 2,
      truncate(`msgs ${this.totalMessages} · tools ${this.totalTools} · ${Math.round(this.totalKb)}kb`, inner - 2),
      GRAY.gray2,
    );
    this.canvas.write(
      box.row + 5,
      box.col + 2,
      truncate(`${spin} ${working}/6 agents working`, inner - 2),
      working ? T.textPrimary : T.border,
    );
  }

  _drawAgents() {
    for (const [key, state] of this.agents) {
      if (key === 'other' && !this.showOther) continue;
      const slot = this._slots.get(key);
      if (!slot) continue;
      const box = slot.box;
      const def = state.def;
      const status = statusGlyph(state, this.now);
      const border = state.flashUntil > this.now ? T.textPrimary : state.status === 'idle' ? T.border : def.color;
      this.canvas.box(box.row, box.col, box.width, box.height, border, def.label);
      const inner = box.width - 2;
      const stamp = { glyph: status.glyph, color: status.color };
      this.canvas.put(box.row, box.col + box.width - 2, stamp.glyph, stamp.color);

      for (let index = 0; index < 2; index += 1) {
        const message = state.messages[index];
        if (!message) {
          if (index === 0 && state.messageCount === 0) {
            this.canvas.write(box.row + 1, box.col + 2, truncate('waiting for task', inner - 2), T.textMuted);
          }
          continue;
        }
        const prefix = message.dir === 'out' ? '»' : '«';
        this.canvas.put(box.row + 1 + index, box.col + 2, prefix, def.color);
        this.canvas.write(box.row + 1 + index, box.col + 4, truncate(message.text, inner - 4), T.textPrimary);
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

  _drawInput() {
    if (this.layout.inputRow == null) return;
    const row = this.layout.inputRow;
    this.canvas.fill(row, 0, this.width, 1, ' ', 0);
    const prompt = 'task> ';
    const inner = Math.max(1, this.width - prompt.length - 3);
    this.canvas.write(row, 1, prompt, this.run.state === 'running' ? T.textSecondary : ORCHESTRATOR.color);
    if (!this.inputValue) {
      this.canvas.write(row, 1 + prompt.length + 2, truncate('type a task and press enter', Math.max(1, inner - 2)), T.border);
      this.canvas.put(row, 1 + prompt.length, '▌', T.textPrimary);
      return;
    }
    // Multiline prompt: collapsed `[pasted n lines]` preview (like opencode),
    // full buffer preserved for submit. Viewport = last line.
    const all = String(this.inputValue).split('\n');
    const total = all.length;
    const lastLine = (all[all.length - 1] ?? '').replace(/\r$/, '');
    const prefix = total > 1 ? `[pasted ${total} lines] ` : '';
    const visible = truncate(prefix + lastLine, inner);
    this.canvas.write(row, 1 + prompt.length, visible, T.textPrimary);
    const cursorCol = 1 + prompt.length + visible.length;
    this.canvas.put(row, cursorCol, '▌', T.textPrimary);
  }

  _drawStatus() {
    const idleTaskHint = this.run.state === 'running'
      ? ' · esc abort'
      : ' · /sessions pick · /new fresh · l log';
    const prefix = this.inputMode
      ? `theFactory · task · ${this._runStatusLine()}${idleTaskHint}`
      : `theFactory · ${this.mode} · ${this.totalMessages} msgs · ${this.packets.length} packet(s) · q quit`;
    const statusColor = !this.inputMode
      ? T.textSecondary
      : this.run.state === 'error'
        ? T.error
        : this.run.state === 'done'
          ? T.success
          : T.textSecondary;
    this.canvas.write(this.layout.statusRow, 1, truncate(prefix, this.width - 2), statusColor);
    const right = `${this.width}×${this.height}`;
    this.canvas.write(this.layout.statusRow, this.width - right.length - 1, right, T.border);
    if (this.inputMode) this._drawInput();
  }

  /** Paint the log overlay on top of everything (only when open). */
  _drawLog() {
    if (!this.logView.open) return;
    const boxWidth = Math.max(24, Math.min(this.width - 4, Math.floor(this.width * 0.7)));
    const boxHeight = Math.max(8, Math.min(this.height - 4, Math.floor(this.height * 0.7)));
    const row = Math.max(1, Math.floor((this.height - boxHeight) / 2));
    const col = Math.max(1, Math.floor((this.width - boxWidth) / 2));
    const key = this.logView.agentKey;
    const label = key === 'orchestrator'
      ? ORCHESTRATOR.label
      : (this.agents.get(key)?.def.label ?? key.toUpperCase());
    const entries = this._logEntries();
    // Clear the overlay so the underlying frame does not bleed through.
    this.canvas.fill(row, col, boxWidth, boxHeight, ' ', 0);
    this.canvas.box(row, col, boxWidth, boxHeight, T.textPrimary, `LOG: ${label}`);
    this.canvas.write(
      row + 1,
      col + 2,
      truncate(`${entries.length} entries · ←/→ agent · ↑/↓ scroll · 1-6 pillars · esc close`, boxWidth - 4),
      T.textSecondary,
    );
    const visibleRows = Math.max(1, boxHeight - 4);
    const lines = this._logLines(visibleRows);
    lines.forEach((line, index) => {
      this.canvas.write(row + 2 + index, col + 2, truncate(line, boxWidth - 4), T.textPrimary);
    });
    if (lines.length === 0) {
      this.canvas.write(row + 2, col + 2, truncate('(no messages yet)', boxWidth - 4), T.textMuted);
    }
    this.canvas.write(
      row + boxHeight - 1,
      col + 2,
      truncate('←/→ agent · ↑/↓ scroll · esc close · 1-6 pillars', boxWidth - 4),
      T.textPrimary,
    );
  }

  /** Paint the config overlay on top of everything (only when open). */
  _drawConfig() {
    if (!this.configView.open) return;
    const info = this.configView.info ?? {};
    const values = {
      model: info.model || '(default)',
      fallbacks: info.fallbackModels?.length ? info.fallbackModels.join(', ') : '(none)',
      auto: info.auto ? 'ON' : 'OFF',
      parallel: info.parallel ? `${info.workers || 3} workers` : 'OFF',
      sequential: info.sequential ? 'ON' : 'OFF',
      nolimit: info.nolimit ? 'ON' : 'OFF',
      dir: info.dir || process.cwd(),
      session: info.session || '(new on next task)',
    };
    const labelWidth = Math.max(...CONFIG_ROWS.map((row) => row.label.length));
    const lines = CONFIG_ROWS.map((row) => {
      const cursor = row.key === this.configView.selected ? '›' : ' ';
      const suffix = row.editable ? '' : '  (read-only)';
      return `${cursor} ${row.label.padEnd(labelWidth)}  ${values[row.key]}${suffix}`;
    });
    const boxWidth = Math.max(36, Math.min(this.width - 4, Math.max(...lines.map((line) => line.length)) + 6));
    const boxHeight = lines.length + 4;
    const row = Math.max(1, Math.floor((this.height - boxHeight) / 2));
    const col = Math.max(1, Math.floor((this.width - boxWidth) / 2));
    // Clear the overlay so the underlying frame does not bleed through.
    this.canvas.fill(row, col, boxWidth, boxHeight, ' ', 0);
    this.canvas.box(row, col, boxWidth, boxHeight, T.border, 'theFactory Configuration');
    this.canvas.write(
      row + 1,
      col + 2,
      truncate('↑/↓ select · ↵/→ change · ← previous · q/esc close', boxWidth - 4),
      T.textSecondary,
    );
    lines.forEach((line, index) => {
      const def = CONFIG_ROWS[index];
      const selected = def.key === this.configView.selected;
      const color = !def.editable
        ? T.textMuted
        : selected
          ? T.textPrimary
          : T.textSecondary;
      this.canvas.write(row + 2 + index, col + 2, truncate(line, boxWidth - 4), color);
    });
  }

  /** Paint the current state into the back buffer. */
  draw() {
    if (this.layout.tooSmall) return;
    this.canvas.clear();
    // theFactory skyline: baked first so overlays cover it; animated whenever
    // agents are working (src hook -> workin_on/factory.js).
    drawFactory(this);
    this._drawBranches();
    this._drawCenter();
    this._drawAgents();
    this._drawPackets();
    this._drawStatus();
    this._drawLog();
    this._drawConfig();
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
