#!/usr/bin/env node
/**
 * CLI entry: argument parsing, picker, snapshot output, and the TTY event loop.
 */

import process from 'node:process';
import { spawn } from 'node:child_process';
import * as readlinePromises from 'node:readline/promises';
import { readFileSync } from 'node:fs';
import { App } from './app.js';
import { AGENT_ORDER } from './agents.js';
import { truncate } from './canvas.js';
import { demoEvents, playDemo } from './demo.js';
import { LineInput } from './input.js';
import { LiveSource, listRootSessions } from './live.js';
import { MIN_HEIGHT, MIN_WIDTH } from './layout.js';
import { launchRun } from './run.js';
import { runTasks } from './scheduler.js';
import { createWorkerManager } from './worker.js';
import { detectConflicts } from './integrate.js';
import {
  buildPlanningPrompt,
  parsePlan,
  fallbackPlan,
} from './plan.js';
import { saveParallelState } from './parallelState.js';
import {
  clearPersistedSession,
  loadPersistedSession,
  savePersistedSession,
} from './sessionState.js';
import { ensureNolimit, nolimitCommand, applyModelToAllAgents } from './nolimit.js';
import { PROFILE_ORDER, applyProfileToAllAgents } from './profiles.js';
import { VERBOSITY_ORDER, applyVerbosityToAllAgents } from './verbosity.js';
import { ensureGraphify, graphifyPrompt, withGraphifyPrompt } from './graphify.js';
import { apiRequest, formAnswerBody } from './opencodeApi.js';
import { openExternalCommand } from './media.js';

const FPS = 12;
const { version } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);
const USAGE = `thefactory — watch an orchestrator talk to its subagents

Usage:
  thefactory                         task mode: type a job, OpenCode runs it live (TTY)
  thefactory nolimit <action>        manage built-in opencode-nolimit (install|start|stop|restart|status|key|models)
  thefactory "fix the failing tests"  prefill the task composer (TTY)
  thefactory --task                  same explicit task mode
  thefactory --picker                choose a session, then replay/follow it (TTY)
  thefactory --live [flags]          replay/follow a session (picker without --session)
  thefactory --demo                  run the scripted workflow
  thefactory --snapshot [n] [mode]   plain-text frames (no alternate screen)
  thefactory --list                  list root sessions and exit

Flags:
  --attach <id|slug>     alias for --session (task and live modes)
  --session <id|slug>    select/continue a session by exact id, id prefix, or slug
                         (task mode: pass --session to opencode run + persist it;
                         live mode: replay/follow that session)
  --new / --fresh        task mode: ignore the persisted session and start brand-new
  --dir <path>           prefer sessions in this directory; task cwd
  --model <model#var>    forwarded to opencode run as -m
  --profile <profile>    apply a low, medium, high, or free model profile in /config
  --verbosity <level>    set agent verbosity: low, medium, or high (lower talks less, saves tokens)
  --fallback-models <csv> comma-separated fallback models tried in order on quota/no-route (bounded, env FACTORY_FALLBACK_MODELS)
  --auto                 auto-approve opencode ask permissions via --auto (explicit opt-in for trusted unattended only; deny stays enforced)
  --no-auto              do not pass --auto (default); ask rules are auto-rejected headlessly (surfaced as ⚠, never silent success)
  --graphify             prepare and use graphify-out/graph.json for task prompts (default)
  --no-graphify          disable graphify (also FACTORY_GRAPHIFY=0)
  --parallel             run tasks in parallel (scheduler + independent workers; default concurrency 3)
  --workers <n>          parallel worker/concurrency limit (default 3, min 1)
  --sequential           force single-worker execution (debugging)
  --resume <dir>         load parallel-state.json from dir and print a safe resume plan (never auto-reruns write work)
  --opencode <path>      opencode binary (or set FACTORY_OPENCODE)
  --limit <n>            latest messages replayed per session (default 200)
  --packet-speed <ms>    backfill pacing, one event per tick (default 400)
  --fast                 replay backfill at ~10x speed
  --follow               keep polling for new DB rows (default in a TTY)
  --no-follow            stop after backfill
  --snapshot [n]         render n frames as plain text (default 1)
  --demo, --live         choose the event source for --snapshot
  --version              print the installed version
  -h, --help             show this help

Task-mode composer commands (typed instead of a task):
  /new                   forget the current session; next task starts a new one
  /sessions              list recent root sessions (pick one, then /resume <id|#n>)
  /resume <id|#n>        continue that session on the next task
  /fallback [list]       show/set quota fallback models (comma-separated, max 8; /fallback clear to reset)
  /models                list OpenCode Go models available for fallback
  /log                   open the log viewer (works even while a task is running)

Keys in task mode: type a task, Enter submits, Backspace edits, Esc aborts a
running task, Ctrl-C always quits, q quits only when the prompt is empty.
Keys in live/demo modes: l opens the log viewer (there is no composer there).
In the log viewer: ←/→ cycle agent (orchestrator + 6 pillars + other), ↑/↓
scroll, 1-6 jump to explorer/architect/developer/reviewer/security/tester,
Esc closes.
The visualizer needs at least ${MIN_WIDTH}x${MIN_HEIGHT}.

Session persistence (task mode): the last session id is saved to
$XDG_STATE_HOME/thefactory/session.json (or ~/.local/state/thefactory/session.json)
and resumes automatically when the working directory matches. Use --new or /new to
start fresh.`;

// OpenCode Go agent models and fallback presets, in preferred selection order.
// theFactory cycles through these in the /config card and uses them as fallback
// presets; /models queries the live OpenCode catalog.
export const GO_MODEL_IDS = [
  'opencode-go/glm-5.3',
  'opencode-go/deepseek-v4-pro',
  'opencode-go/mimo-v2.6-flash',
  'opencode-go/kimi-k3.1-pro',
  'opencode-go/claude-haiku-5-5',
  'opencode-go/grok-4.7',
  'opencode-go/glm-5.3-flash',
  'opencode-go/deepseek-v4.1-flash',
  'opencode-go/qwen3.8-max',
  'opencode-go/minimax-m3',
];

/**
 * Cycle one /config card row's value on `options` (mutates in place, matching
 * the /fallback command's live-edit pattern). `memory` carries the user's own
 * model id and fallback list (CLI/env/…/fallback) as extra cycle steps.
 * Returns a display label for the log, or null for unknown/non-editable keys.
 */
export function cycleConfigValue(options, key, dir = 1, memory = {}) {
  const step = dir < 0 ? -1 : 1;
  if (key === 'model') {
    const custom = typeof memory.model === 'string' ? memory.model : null;
    const cycle = [...(custom ? [custom] : []), null, ...GO_MODEL_IDS];
    const index = cycle.indexOf(options.model ?? null);
    const next = cycle[(Math.max(0, index) + step + cycle.length) % cycle.length];
    options.model = next;
    return next ?? '(default)';
  }
  if (key === 'profile') {
    const cycle = [null, ...PROFILE_ORDER];
    const index = cycle.indexOf(options.profile ?? null);
    const next = cycle[(Math.max(0, index) + step + cycle.length) % cycle.length];
    options.profile = next;
    return next ? next.toUpperCase() : '(default)';
  }
  if (key === 'verbose') {
    const cycle = [null, ...VERBOSITY_ORDER];
    const index = cycle.indexOf(options.verbosity ?? null);
    const next = cycle[(Math.max(0, index) + step + cycle.length) % cycle.length];
    options.verbosity = next;
    return next ? next.toUpperCase() : '(default)';
  }
  if (key === 'fallbacks') {
    const presets = [
      [],
      ...GO_MODEL_IDS.map((model) => [model]),
      ...(Array.isArray(memory.fallbacks) && memory.fallbacks.length ? [[...memory.fallbacks]] : []),
    ];
    const current = Array.isArray(options.fallbackModels) ? options.fallbackModels : [];
    const index = presets.findIndex((preset) => preset.join(',') === current.join(','));
    const next = presets[(Math.max(0, index) + step + presets.length) % presets.length];
    options.fallbackModels = next;
    return next.length ? next[0] : '(none)';
  }
  if (key === 'auto') {
    options.auto = !options.auto;
    return options.auto ? 'ON' : 'OFF';
  }
  if (key === 'parallel') {
    const cycle = [
      { parallel: false },
      { parallel: true, workers: 3 },
      { parallel: true, workers: 4 },
      { parallel: true, workers: 6 },
    ];
    const index = cycle.findIndex(
      (entry) => entry.parallel === Boolean(options.parallel)
        && (options.parallel ? (options.workers ?? 3) === entry.workers : true),
    );
    const next = cycle[(Math.max(0, index) + step + cycle.length) % cycle.length];
    options.parallel = next.parallel;
    if (next.parallel) options.workers = next.workers;
    return next.parallel ? `${next.workers} workers` : 'OFF';
  }
  if (key === 'sequential') {
    options.sequential = !options.sequential;
    return options.sequential ? 'ON' : 'OFF';
  }
  if (key === 'nolimit') {
    options.nolimit = options.nolimit ? null : 'status';
    return options.nolimit ? 'ON' : 'OFF';
  }
  if (key === 'graphify') {
    options.graphify = !options.graphify;
    return options.graphify ? 'ON' : 'OFF';
  }
  return null;
}

/** Parse the small, dependency-free flag set. */
export function parseArgs(argv) {
  const options = {
    mode: null,
    snapshot: null,
    session: null,
    fresh: false,
    dir: null,
    limit: 200,
    follow: null,
    packetSpeed: 400,
    fast: false,
    model: null,
    profile: null,
    verbosity: null,
    auto: false,
    graphify: true,
    parallel: false,
    workers: 3,
    sequential: false,
    opencode: null,
    task: null,
    help: false,
    version: false,
    nolimit: null,
    resume: null,
    fallbackModels: [],
  };
  // Env fallback selector (comma-separated, no spaces needed).
  const envFallback = process.env.FACTORY_FALLBACK_MODELS;
  if (envFallback) options.fallbackModels = parseModelList(envFallback);
  if (process.env.FACTORY_GRAPHIFY === '0') options.graphify = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--demo') options.mode = 'demo';
    else if (arg === '--live') options.mode = 'live';
    else if (arg === '--task') options.mode = 'task';
    else if (arg === '--picker') options.mode = 'picker';
    else if (arg === '--list') options.mode = 'list';
    else if (arg === '--new' || arg === '--fresh') options.fresh = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--version' || arg === '-v') options.version = true;
    else if (arg === 'nolimit') {
      const next = argv[index + 1];
      if (next && !next.startsWith('-')) {
        options.nolimit = next;
        index += 1;
      } else {
        options.nolimit = 'status';
      }
    }
    else if (arg === '--snapshot') {
      const next = argv[index + 1];
      if (next && /^\d+$/.test(next)) {
        options.snapshot = Math.max(1, Number.parseInt(next, 10));
        index += 1;
      } else {
        options.snapshot = 1;
      }
    } else if (arg === '--session' || arg === '--attach') {
      options.session = requireValue(argv, index, arg);
      index += 1;
    } else if (arg === '--model') {
      options.model = requireValue(argv, index, arg);
      index += 1;
    } else if (arg === '--profile') {
      const profile = requireValue(argv, index, arg);
      if (!PROFILE_ORDER.includes(profile)) {
        throw new Error('--profile expects low, medium, high, or free');
      }
      options.profile = profile;
      index += 1;
    } else if (arg === '--verbosity') {
      const verbosity = requireValue(argv, index, arg);
      if (!VERBOSITY_ORDER.includes(verbosity)) {
        throw new Error('--verbosity expects low, medium, or high');
      }
      options.verbosity = verbosity;
      index += 1;
    } else if (arg === '--fallback-models') {
      options.fallbackModels = parseModelList(requireValue(argv, index, arg));
      index += 1;
    } else if (arg === '--opencode') {
      options.opencode = requireValue(argv, index, arg);
      index += 1;
    } else if (arg === '--dir') {
      options.dir = requireValue(argv, index, arg);
      index += 1;
    } else if (arg === '--limit') {
      options.limit = parsePositiveInt(requireValue(argv, index, arg), '--limit', 1);
      index += 1;
    } else if (arg === '--packet-speed') {
      options.packetSpeed = parsePositiveInt(requireValue(argv, index, arg), '--packet-speed', 20);
      index += 1;
    } else if (arg === '--follow') {
      options.follow = true;
    } else if (arg === '--no-follow') {
      options.follow = false;
    } else if (arg === '--fast') {
      options.fast = true;
    } else if (arg === '--auto') {
      options.auto = true;
    } else if (arg === '--no-auto') {
      options.auto = false;
    } else if (arg === '--graphify') {
      options.graphify = true;
    } else if (arg === '--no-graphify') {
      options.graphify = false;
    } else if (arg === '--parallel') {
      options.parallel = true;
    } else if (arg === '--resume') {
      options.resume = requireValue(argv, index, arg);
      index += 1;
    } else if (arg === '--sequential') {
      options.sequential = true;
      options.parallel = false;
    } else if (arg === '--workers') {
      options.workers = parsePositiveInt(requireValue(argv, index, arg), '--workers', 1);
      options.parallel = true;
      index += 1;
    } else if (!arg.startsWith('-')) {
      if (options.task) options.task = `${options.task} ${arg}`;
      else options.task = arg;
    } else {
      throw new Error(`Unknown argument: ${arg} (try --help)`);
    }
  }
  return options;
}

function requireValue(argv, index, flag) {
  const value = argv[index + 1];
  if (value == null || value.startsWith('-')) throw new Error(`Missing value for ${flag}`);
  return value;
}

function parsePositiveInt(value, flag, minimum) {
  if (!/^\d+$/.test(value)) throw new Error(`${flag} expects a positive integer`);
  const parsed = Number.parseInt(value, 10);
  if (parsed < minimum) throw new Error(`${flag} must be at least ${minimum}`);
  return parsed;
}

/** Split a comma-separated fallback list into clean model ids. */
export function parseModelList(csv) {
  return String(csv ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 8); // bounded — never more than 8 fallbacks
}

/**
 * True only when this run needs the bundled OC-NOLIMIT proxy: an explicit
 * nolimit toggle, or an OC-NOLIMIT primary/fallback model. Go-only runs never
 * pay the proxy startup cost or fail because Bun is missing.
 */
export function usesNolimit({ model, fallbackModels, nolimit } = {}) {
  if (nolimit) return true;
  const models = [model, ...(Array.isArray(fallbackModels) ? fallbackModels : [])];
  return models.some((entry) => typeof entry === 'string' && entry.startsWith('OC-NOLIMIT/'));
}

function terminalSize() {
  const width = Number(process.env.COLUMNS) || process.stdout.columns || 100;
  const height = Number(process.env.LINES) || process.stdout.rows || 32;
  return { width: Math.floor(width), height: Math.floor(height) };
}

function chooseMode(options, isTTY) {
  if (options.mode) return options.mode;
  if (options.snapshot != null) return options.session || options.dir ? 'live' : 'demo';
  if (options.session || options.dir) return 'live';
  return isTTY ? 'task' : 'demo';
}

function pad(value, width) {
  return truncate(value ?? '', width).padEnd(width, ' ');
}

function sessionTable(sessions, numbered = false) {
  const header = [
    ...(numbered ? ['  #'] : []),
    'ID'.padEnd(30),
    'SLUG'.padEnd(16),
    'AGENT'.padEnd(12),
    'CHILD'.padEnd(5),
    'TITLE'.padEnd(46),
  ];
  const rows = [header.join(' ')];
  sessions.forEach((session, index) => {
    const cells = [];
    if (numbered) cells.push(pad(String(index + 1), 3));
    cells.push(pad(session.id, 30));
    cells.push(pad(session.slug, 16));
    cells.push(pad(session.agent, 12));
    cells.push(pad(String(session.child_count ?? 0), 5));
    cells.push(pad(session.title, 46));
    rows.push(cells.join(' '));
  });
  return rows.join('\n');
}

function runList(options) {
  const sessions = listRootSessions({ dir: options.dir, limit: 30 });
  if (sessions.length === 0) {
    process.stdout.write('No root sessions found.\n');
    return 0;
  }
  process.stdout.write(`${sessionTable(sessions)}\n`);
  return 0;
}

async function pickSession(options) {
  const sessions = listRootSessions({ dir: options.dir, limit: 20 });
  if (sessions.length === 0) {
    process.stderr.write('No root sessions found.\n');
    return null;
  }
  process.stdout.write(`${sessionTable(sessions, true)}\n\n`);
  const rl = readlinePromises.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question('Select a session number (q to quit): ')).trim();
    if (!answer || answer.toLowerCase() === 'q') return null;
    const index = Number.parseInt(answer, 10) - 1;
    if (!Number.isInteger(index) || index < 0 || index >= sessions.length) {
      process.stderr.write('Invalid selection.\n');
      return null;
    }
    return sessions[index].id;
  } finally {
    rl.close();
  }
}

function applySessionCounts(app, source) {
  for (const [key, count] of source.agentCounts()) app.setSessionCount(key, count);
}

function buildDemoFrames(frames, width, height) {
  const app = new App({ width, height, color: false, mode: 'demo' });
  const timeline = demoEvents();
  const total = (timeline[timeline.length - 1]?.at ?? 0) + 2500;
  const output = [];
  let applied = 0;

  for (let frame = 1; frame <= frames; frame += 1) {
    const target = frames === 1 ? total : Math.round((total * frame) / frames);
    while (applied < timeline.length && timeline[applied].at <= target) {
      const entry = timeline[applied];
      applied += 1;
      app.advance(entry.at - app.now);
      app.applyEvent(entry.event);
    }
    app.advance(target - app.now);
    output.push(app.snapshot());
  }
  return output;
}

function buildLiveFrames(source, frames, width, height) {
  const app = new App({ width, height, color: false, mode: 'live' });
  applySessionCounts(app, source);
  const events = source.loadBackfill();
  const output = [];
  let applied = 0;
  const chunk = Math.max(400, Math.ceil(4000 / frames));

  for (let frame = 1; frame <= frames; frame += 1) {
    const upto = Math.ceil((events.length * frame) / frames);
    while (applied < upto) {
      app.applyEvent(events[applied]);
      applied += 1;
    }
    app.advance(chunk);
    output.push(app.snapshot());
  }
  return output;
}

function runSnapshot(mode, options, frames) {
  const { width, height } = terminalSize();
  if (width < MIN_WIDTH || height < MIN_HEIGHT) {
    process.stderr.write(
      `theFactory needs a terminal of at least ${MIN_WIDTH}x${MIN_HEIGHT} (got ${width}x${height}).\n`,
    );
    return 1;
  }

  const count = Math.max(1, Math.min(100, frames | 0));
  let output;
  if (mode === 'live') {
    const source = new LiveSource({ session: options.session, dir: options.dir, limit: options.limit });
    try {
      source.open();
      output = buildLiveFrames(source, count, width, height);
    } finally {
      source.close();
    }
  } else {
    output = buildDemoFrames(count, width, height);
  }

  process.stdout.write(`${output.join('\n\f\n')}\n`);
  return 0;
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function runTui(mode, options) {
  const { width, height } = terminalSize();
  if (width < MIN_WIDTH || height < MIN_HEIGHT) {
    process.stderr.write(
      `theFactory needs a terminal of at least ${MIN_WIDTH}x${MIN_HEIGHT} (got ${width}x${height}).\n`,
    );
    return 1;
  }

  const app = new App({
    width,
    height,
    color: !('NO_COLOR' in process.env),
    mode,
    inputMode: mode === 'task',
  });

  // CLI profile/verbosity flags mutate the global OpenCode config before the
  // first task, so the next `opencode run` picks them up. Failures are logged
  // (never fatal) because the TUI still works with the existing config.
  if (mode === 'task') {
    if (options.profile) {
      const applied = applyProfileToAllAgents(options.profile);
      app.addLog(applied.ok
        ? `profile ${options.profile} · applied to ${applied.agents} agent(s) + default`
        : `! profile ${options.profile} · ${applied.error ?? 'apply failed'}`);
    }
    if (options.verbosity) {
      const applied = applyVerbosityToAllAgents(options.verbosity);
      app.addLog(applied.ok
        ? `verbose ${options.verbosity} · applied to ${applied.agents} agent(s)`
        : `! verbose ${options.verbosity} · ${applied.error ?? 'apply failed'}`);
    }
  }

  const out = process.stdout;
  const input = process.stdin;
  let source = null;
  let demoHandle = null;
  let pollTimer = null;
  let renderTimer = null;
  let raw = false;
  let stopped = false;
  let restored = false;
  let screenEntered = false;
  let small = false;
  let fatal = null;
  let activeRun = null;
  let preparingRun = false;
  let abortRequested = false;
  let hadPermissionFailure = false;
  let permissionFailureMessage = '';
  let killTimer = null;
  let attachTimer = null;
  let formPollTimer = null;
  let formPollInFlight = false;
  let formPollEpoch = 0;
  let pendingFormID = null;
  let questionRequest = null;
  const seenForms = new Set();
  const seenImages = new Set();
  let lastText = '';
  let runToken = 0;
  const lineInput = mode === 'task' ? new LineInput(options.task ?? '') : null;
  if (lineInput) app.setInputValue(lineInput.value);
  // Persistent session: --session wins, --new/--fresh ignores the file,
  // otherwise resume the persisted id when its dir matches.
  let currentSessionID = null;
  if (mode === 'task') {
    if (options.session) {
      currentSessionID = options.session;
    } else if (!options.fresh) {
      const persisted = loadPersistedSession({ dir: options.dir });
      if (persisted) currentSessionID = persisted.sessionID;
    }
    if (currentSessionID && !options.fresh) {
      savePersistedSession({ sessionID: currentSessionID, dir: options.dir });
    }
  }

  const apiBin = options.opencode ?? process.env.FACTORY_OPENCODE ?? 'opencode';
  const apiOptions = { bin: apiBin };

  const stopFormPolling = () => {
    formPollEpoch += 1;
    if (formPollTimer) clearTimeout(formPollTimer);
    formPollTimer = null;
  };

  const scheduleFormPoll = (epoch, delay = 900) => {
    if (stopped || epoch !== formPollEpoch || mode !== 'task' || !currentSessionID) return;
    if (app.run.state !== 'running') return;
    if (formPollTimer) clearTimeout(formPollTimer);
    formPollTimer = setTimeout(() => { void pollPendingForms(epoch); }, delay);
  };

  const pollPendingForms = async (epoch) => {
    formPollTimer = null;
    if (stopped || epoch !== formPollEpoch || mode !== 'task') return;
    if (formPollInFlight) {
      scheduleFormPoll(epoch, 200);
      return;
    }
    const sessionID = currentSessionID;
    if (!sessionID || app.run.state !== 'running') return;
    // Polling may start while graphify/nolimit preparation is still underway.
    if (!activeRun) {
      scheduleFormPoll(epoch, 250);
      return;
    }

    const token = runToken;
    formPollInFlight = true;
    try {
      const result = await apiRequest(
        'get',
        `/api/session/${encodeURIComponent(sessionID)}/form`,
        null,
        apiOptions,
      );
      if (stopped || epoch !== formPollEpoch || token !== runToken) return;
      if (!result.ok || app.questionView.open) return;
      const forms = Array.isArray(result.data?.data)
        ? result.data.data
        : Array.isArray(result.data)
          ? result.data
          : [];
      const form = forms.find((entry) => (
        entry && typeof entry === 'object' && typeof entry.id === 'string' && !seenForms.has(entry.id)
      ));
      if (!form) return;
      seenForms.add(form.id);
      pendingFormID = form.id;
      app.openQuestion(form, { sessionID });
      app.addLog(`❓ question: ${form.title || form.id}`);
    } catch {
      // Polling is opportunistic; a shared-server restart must not fail a run.
    } finally {
      formPollInFlight = false;
      scheduleFormPoll(epoch);
    }
  };

  const startFormPolling = () => {
    stopFormPolling();
    if (mode !== 'task' || !currentSessionID || app.run.state !== 'running') return;
    scheduleFormPoll(formPollEpoch, 0);
  };

  const pollFormsSoon = () => {
    if (mode === 'task' && currentSessionID && app.run.state === 'running') {
      scheduleFormPoll(formPollEpoch, 0);
    }
  };

  const closeQuestionAtRunEnd = () => {
    pendingFormID = null;
    if (!app.questionView.open) return;
    app.closeQuestion();
    app.addLog('question closed · run finished');
  };

  const answerQuestion = async (answer) => {
    const state = app.questionView;
    const sessionID = state.sessionID ?? currentSessionID;
    const formID = pendingFormID ?? state.form?.id;
    if (!state.open || !sessionID || !formID || questionRequest) return;
    const token = runToken;
    const request = { state, token };
    questionRequest = request;
    try {
      const result = await apiRequest(
        'post',
        `/api/session/${encodeURIComponent(sessionID)}/form/${encodeURIComponent(formID)}/reply`,
        formAnswerBody(answer),
        apiOptions,
      );
      if (stopped || token !== runToken || app.questionView !== state) return;
      if (!result.ok) {
        const message = result.error || 'question reply failed';
        app.setQuestionError(message);
        app.addLog(`! question: ${truncate(message, 100)}`);
        return;
      }
      app.closeQuestion();
      pendingFormID = null;
      app.addLog('✓ question answered');
      pollFormsSoon();
    } finally {
      if (questionRequest === request) questionRequest = null;
    }
  };

  const cancelQuestion = () => {
    const state = app.questionView;
    const sessionID = state.sessionID ?? currentSessionID;
    const formID = pendingFormID ?? state.form?.id;
    if (!state.open) return;
    app.closeQuestion();
    pendingFormID = null;
    app.addLog('question cancelled');
    if (sessionID && formID) {
      void apiRequest(
        'delete',
        `/api/session/${encodeURIComponent(sessionID)}/form/${encodeURIComponent(formID)}`,
        null,
        apiOptions,
      ).catch(() => {}).finally(pollFormsSoon);
    } else {
      pollFormsSoon();
    }
  };

  const openExternal = (target) => {
    if (!target) return;
    try {
      const { command, args } = openExternalCommand(target);
      const child = spawn(command, args, { detached: true, stdio: 'ignore' });
      child.once('error', (error) => {
        if (!stopped) app.addLog(`! open externally: ${truncate(error?.message ?? String(error), 90)}`);
      });
      child.unref();
    } catch (error) {
      app.addLog(`! open externally: ${truncate(error?.message ?? String(error), 90)}`);
    }
  };

  // Current settings for the /config card. Readers (run launch, scheduler)
  // consume `options` at launch time, so live mutations apply to the next task.
  const configSnapshot = () => ({
    model: options.model,
    profile: options.profile,
    verbosity: options.verbosity,
    fallbackModels: options.fallbackModels,
    auto: options.auto,
    graphify: options.graphify,
    parallel: options.parallel,
    workers: options.workers,
    sequential: options.sequential,
    dir: options.dir,
    session: currentSessionID ?? options.session,
    nolimit: options.nolimit,
  });

  // User-authored model/fallbacks (CLI/env/…/fallback), remembered so the card
  // cycle keeps them as extra steps between the built-in presets.
  let customModel = null;
  let customFallbackModels = null;
  const rememberCustoms = () => {
    const list = Array.isArray(options.fallbackModels) ? options.fallbackModels : [];
    if (list.length > 0) customFallbackModels = [...list];
    if (options.model && !GO_MODEL_IDS.includes(options.model)) customModel = options.model;
  };

  /** Cycle the selected config row's value (enter/←/→ inside the card). */
  const applyConfigChange = (key, dir = 1) => {
    const value = cycleConfigValue(options, key, dir, { model: customModel, fallbacks: customFallbackModels });
    if (value === null) return;
    if (key === 'model') {
      // The card's model is global: push it into opencode.json for the
      // orchestrator, every subagent, and the top-level default.
      const applied = applyModelToAllAgents(options.model);
      let profileError = null;
      // The free profile pins every agent, so an explicit model choice exits it.
      const freeNote = options.profile === 'free' ? ' · free profile cleared' : '';
      if (options.profile === 'free') options.profile = null;
      if (applied.ok && options.profile) {
        const profileApplied = applyProfileToAllAgents(options.profile);
        if (!profileApplied.ok) profileError = profileApplied.error ?? 'profile apply failed';
      }
      if (applied.ok && !profileError) {
        app.addLog(`config · model → ${value} · applied to all ${applied.agents} agent(s) + default${freeNote}`);
      } else {
        const error = applied.ok ? profileError : (applied.error ?? 'apply failed');
        app.addLog(`! config · model → ${value} · ${truncate(error, 90)}`);
      }
    } else if (key === 'profile') {
      const applied = applyProfileToAllAgents(options.profile);
      if (applied.ok) {
        app.addLog(`config · profile → ${value} · applied to ${applied.agents} agent(s) + default`);
      } else {
        app.addLog(`! config · profile → ${value} · ${truncate(applied.error ?? 'apply failed', 90)}`);
      }
    } else if (key === 'verbose') {
      const applied = applyVerbosityToAllAgents(options.verbosity);
      if (applied.ok) {
        app.addLog(`config · verbose → ${value} · applied to ${applied.agents} agent(s)`);
      } else {
        app.addLog(`! config · verbose → ${value} · ${truncate(applied.error ?? 'apply failed', 90)}`);
      }
    } else {
      app.addLog(`config · ${key} → ${value}`);
    }
    app.updateConfigInfo(configSnapshot());
  };

  let finish;
  const done = new Promise((resolve) => {
    finish = resolve;
  });

  const restore = () => {
    if (restored) return;
    restored = true;
    try { out.write('\x1b[?2004l'); } catch {}
    if (renderTimer) clearInterval(renderTimer);
    if (pollTimer) clearInterval(pollTimer);
    if (killTimer) clearTimeout(killTimer);
    if (attachTimer) clearTimeout(attachTimer);
    stopFormPolling();
    activeRun?.kill('SIGTERM');
    activeRun = null;
    demoHandle?.stop();
    source?.close();
    input.removeListener('data', onKey);
    process.removeListener('SIGINT', onSigint);
    out.removeListener('resize', onResize);
    if (raw) {
      try {
        input.setRawMode(false);
      } catch {
        // Terminal may already be gone.
      }
      raw = false;
    }
    try {
      input.pause();
      input.unref?.();
    } catch {
      // stdin may already be closed.
    }
    if (screenEntered) {
      try { out.write('\x1b[?1000l\x1b[?1006l'); } catch {}
      out.write('\x1b[0m\x1b[?25h\x1b[?1049l');
    }
  };

  const stop = (code = 0) => {
    if (stopped) return;
    stopped = true;
    restore();
    finish(code);
  };

  const startPolling = () => {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(() => {
      if (stopped || !source) return;
      try {
        for (const event of source.poll()) app.applyEvent(event);
        applySessionCounts(app, source);
      } catch (error) {
        app.applyEvent({
          kind: 'status',
          from: 'orchestrator',
          text: `db poll: ${truncate(error?.message ?? String(error), 50)}`,
        });
      }
    }, 1000);
  };

  const attachRoot = (rootId) => {
    if (stopped || !rootId) return;
    if (source?.root?.id === rootId) return;
    if (attachTimer) return;
    let attempts = 0;
    const attempt = () => {
      attachTimer = null;
      if (stopped) return;
      const next = new LiveSource({ session: rootId, limit: options.limit });
      try {
        next.open();
        source?.close();
        source = next;
        applySessionCounts(app, next);
        for (const event of next.loadBackfill()) app.applyEvent(event);
        startPolling();
      } catch (error) {
        next.close();
        attempts += 1;
        if (attempts < 20 && !stopped) attachTimer = setTimeout(attempt, 600);
        else app.addLog(`! db attach: ${truncate(error?.message ?? String(error), 80)}`);
      }
    };
    attempt();
  };

  const handleParsed = (parsed) => {
    if (parsed.sessionID) {
      currentSessionID = parsed.sessionID;
      savePersistedSession({ sessionID: currentSessionID, dir: options.dir });
      app.setRunSession(parsed.sessionID);
      attachRoot(parsed.sessionID);
      if (!formPollTimer && !formPollInFlight) startFormPolling();
    }
    for (const image of parsed.images ?? []) {
      const key = image?.path ?? image?.url ?? image?.uri;
      if (!key || seenImages.has(key)) continue;
      seenImages.add(key);
      const label = image.name || String(image.path || image.url || 'image').split(/[\\/]/).pop() || 'image';
      app.addLog(`🖼 image: ${label}`);
      app.openImage(image);
    }
    if (parsed.text) {
      lastText = parsed.text;
      app.addLog(`▸ ${truncate(parsed.text, 110)}`);
    }
    if (parsed.permission) {
      const action = parsed.permission.action ?? 'permission';
      const pattern = parsed.permission.pattern ?? '';
      const label = `⚠ permission requested: ${action}${pattern ? ` (${pattern})` : ''}`;
      app.addLog(label);
      hadPermissionFailure = true;
      permissionFailureMessage = label;
      const alreadyApplied = (parsed.events ?? []).some((event) => event?.text === label);
      if (!alreadyApplied) {
        app.applyEvent({ kind: 'status', from: 'orchestrator', text: label });
      }
    }
    for (const event of parsed.events ?? []) app.applyEvent(event);
    if (parsed.error) {
      const rawError = String(parsed.error);
      const denied = /permission denied/i.test(rawError);
      if (denied) {
        // Idempotent label: parsed.error may already start with
        // "Permission denied: ..." (e.g. from parseRunLine tool errors), so
        // strip that prefix before adding it, avoiding
        // "⚠ permission denied: Permission denied: ...".
        const detail = rawError.replace(/^\s*permission denied:\s*/i, '');
        app.addLog(`⚠ permission denied: ${truncate(detail, 100)}`);
        hadPermissionFailure = true;
        permissionFailureMessage = truncate(rawError, 100);
      } else {
        app.addLog(`! ${truncate(rawError, 100)}`);
        if (/tool execution interrupted|permission requested/i.test(rawError)) {
          hadPermissionFailure = true;
          permissionFailureMessage = truncate(rawError, 100);
        }
      }
    }
  };

  const finishTask = (result) => {
    activeRun = null;
    stopFormPolling();
    if (killTimer) {
      clearTimeout(killTimer);
      killTimer = null;
    }
    if (stopped) return;
    closeQuestionAtRunEnd();
    if (app.run.sessionID) {
      currentSessionID = app.run.sessionID;
      savePersistedSession({ sessionID: currentSessionID, dir: options.dir });
    }
    const elapsed = Math.max(
      0,
      Math.floor((app.run.startedAt ? app.now - app.run.startedAt : 0) / 1000),
    );
    if (result.error) {
      const rawMessage = String(result.error?.message ?? result.error);
      const message =
        result.error?.code === 'ENOENT' || /ENOENT/.test(rawMessage)
          ? 'opencode binary not found — set FACTORY_OPENCODE or install opencode'
          : rawMessage;
      app.finishRun('error', message);
      app.addLog('═══ FAILED TASK REPORT ═══');
      app.addLog(`reason: ${truncate(message, 108)}`);
      app.addLog(`! ${truncate(message, 110)}`);
      app.applyEvent({ kind: 'status', from: 'orchestrator', text: `✗ FAILED TASK REPORT · ${truncate(message, 70)}` });
    } else if (abortRequested) {
      app.finishRun('aborted');
      app.addLog('═══ FAILED TASK REPORT ═══');
      app.addLog('reason: task aborted by user');
      app.addLog(`■ aborted after ${elapsed}s`);
      app.applyEvent({ kind: 'status', from: 'orchestrator', text: '■ FAILED TASK REPORT · aborted' });
    } else if (result.code === 0 && hadPermissionFailure) {
      const message = permissionFailureMessage || 'permission denied — see log';
      app.finishRun('error', message);
      app.addLog('═══ FAILED TASK REPORT ═══');
      app.addLog(`reason: ${truncate(message, 108)}`);
      app.addLog(`! ${truncate(message, 110)}`);
      app.applyEvent({ kind: 'status', from: 'orchestrator', text: `✗ FAILED TASK REPORT · ${truncate(message, 70)}` });
    } else if (result.code === 0) {
      const detail = lastText.trim();
      app.finishRun('done', detail);
      app.addLog('═══ FINISHED TASK REPORT ═══');
      if (detail) {
        for (const line of detail.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (trimmed) app.addLog(trimmed.slice(0, 110));
        }
      } else {
        app.addLog('(no final report)');
      }
      app.addLog(`✓ complete in ${elapsed}s`);
      app.applyEvent({
        kind: 'status',
        from: 'orchestrator',
        text: `✓ FINISHED TASK REPORT · ${Math.max(1, elapsed)}s`,
      });
    } else {
      const stderrTail = String(result.stderr ?? '')
        .trim()
        .split('\n')
        .filter(Boolean)
        .slice(-2)
        .join(' ');
      const message = stderrTail || `opencode exited with code ${result.code}`;
      app.finishRun('error', message);
      app.addLog('═══ FAILED TASK REPORT ═══');
      app.addLog(`reason: ${truncate(message, 108)}`);
      app.addLog(`! ${truncate(message, 110)}`);
      app.applyEvent({ kind: 'status', from: 'orchestrator', text: `✗ FAILED TASK REPORT · ${truncate(message, 70)}` });
    }
    abortRequested = false;
    app.setInputValue(lineInput?.value ?? '');
  };

  const abortTask = () => {
    stopFormPolling();
    if (!activeRun) {
      lineInput?.reset();
      app.setInputValue('');
      return;
    }
    if (abortRequested) return;
    abortRequested = true;
    app.addLog('■ abort requested');
    app.applyEvent({ kind: 'status', from: 'orchestrator', text: 'aborting opencode run…' });
    activeRun.kill('SIGTERM');
    if (killTimer) clearTimeout(killTimer);
    killTimer = setTimeout(() => {
      if (activeRun) activeRun.kill('SIGKILL');
    }, 2500);
  };

  /**
   * Parallel engine wiring (Phases 1–6): plan the objective into a task DAG,
   * dispatch it through the scheduler with independent opencode workers, then
   * report conflicts and persist state for /resume. Never a silent success —
   * every worker outcome is logged and surfaced on the agent pillars.
   */
  const launchParallelRun = async (objective, token, graphifyGuide = null) => {
    const concurrency = options.sequential ? 1 : (options.workers ?? 3);
    const runId = `run_${Date.now()}`;

    // --- Phase 1: plan (fresh session so the plan is unpolluted).
    app.applyEvent({
      kind: 'status',
      from: 'orchestrator',
      text: `planning: decomposing into tasks · ${concurrency} worker${concurrency === 1 ? '' : 's'}`,
    });
    const planChunks = [];
    let plan;
    let plannerWarn = null;
    let plannerHandle = null;
    let manager = null;
    // Unified abort: while the planner runs, kill its child; once workers
    // exist, cancel running ones. killTimer's late SIGKILL hits handles.
    activeRun = {
      kill: (signal) => {
        try { plannerHandle?.kill(signal); } catch {}
        if (!manager) return;
        for (const [workerId, record] of manager.workers) {
          if (record.state !== 'running' || !record.handle) continue;
          try {
            if (signal === 'SIGKILL') record.handle.kill('SIGKILL');
            else manager.cancel(workerId);
          } catch {}
        }
      },
    };
    try {
      plannerHandle = launchRun({
        task: buildPlanningPrompt(objective, {
          maxTasks: Math.max(2, Math.min(8, concurrency * 2)),
          sequential: Boolean(options.sequential),
        }),
        model: options.model,
        auto: options.auto,
        dir: options.dir,
        bin: options.opencode,
        onEvent: (parsed) => {
          if (parsed.text) planChunks.push(parsed.text);
        },
        onError: () => {},
      });
      const planResult = await plannerHandle.done;
      plannerHandle = null;
      if (stopped || token !== runToken) return;
      if (planResult.code !== 0 && !planChunks.length) {
        throw new Error(`planner run failed: ${planResult.error?.message ?? `exit ${planResult.code}`}`);
      }
      try {
        plan = parsePlan(planChunks.join('\n'));
      } catch (error) {
        throw new Error(error?.message ?? String(error));
      }
    } catch (error) {
      plannerHandle = null;
      plannerWarn = truncate(error?.message ?? String(error), 120);
      plan = fallbackPlan(objective);
      app.addLog(`! planner failed: ${plannerWarn} — single-task fallback`);
      app.applyEvent({
        kind: 'status',
        from: 'orchestrator',
        text: `⚠ planner failed — single-task fallback (${concurrency} worker${concurrency === 1 ? '' : 's'})`,
      });
    }
    if (stopped || token !== runToken) return;
    app.addLog(`plan: ${plan.length} task(s) — ${plan.map((t) => `${t.id}:${t.agent}`).join(' ')}`);
    app.applyEvent({
      kind: 'status',
      from: 'orchestrator',
      text: `plan: ${plan.length} task(s) accepted`,
    });

    // --- Phases 3–6: dispatch through the scheduler with real workers.
    manager = createWorkerManager({
      model: options.model,
      fallbackModels: options.fallbackModels ?? [],
      dir: options.dir,
      bin: options.opencode,
      auto: options.auto,
      graphifyGuide,
    });
    const taskById = new Map(plan.map((t) => [t.id, t]));
    const agentOf = (taskId) => taskById.get(taskId)?.agent ?? 'other';
    const refreshPanel = () => app.setParallelWorkers(manager.list());
    refreshPanel();

    const offBus = manager.bus.onEvent((evt) => {
      if (token !== runToken || stopped) return;
      const agent = agentOf(evt.taskId);
      const task = taskById.get(evt.taskId);
      if (evt.kind === 'worker-started') {
        refreshPanel();
        const title = truncate(task?.title ?? evt.taskId, 60);
        app.addLog(`▶ ${agent}: ${title}`);
        app.applyEvent({ kind: 'msg', dir: 'out', to: agent, text: task?.title ?? evt.taskId });
      } else if (evt.kind === 'completed') {
        refreshPanel();
        const record = manager.workers.get(evt.workerId);
        const summary = truncate(String(record?.output ?? '').trim() || 'done', 90);
        app.addLog(`✓ ${agent}: ${summary}`);
        app.applyEvent({ kind: 'msg', dir: 'in', from: agent, text: record?.output ?? 'done' });
      } else if (evt.kind === 'failed' || evt.kind === 'cancelled') {
        refreshPanel();
        const record = manager.workers.get(evt.workerId);
        const detail = truncate(String(record?.error ?? evt.text ?? evt.kind), 90);
        app.addLog(`✗ ${agent}: ${detail}`);
        app.applyEvent({ kind: 'status', from: agent, text: `✗ ${detail}` });
      } else if (evt.kind === 'tool') {
        app.applyEvent({ kind: 'tool', from: agent, text: evt.text });
      } else if (evt.kind === 'permission') {
        app.addLog(`⚠ ${agent}: permission requested — see --auto or allow rules`);
      }
      // 'started'/'session'/'failure' are logged implicitly via panel updates;
      // keep the log feed focused on outcomes.
    });

    let planFailed = false;
    try {
      await runTasks({
        tasks: plan,
        concurrency,
        sequential: Boolean(options.sequential),
        executor: (task) => {
          const { done } = manager.start({
            runId,
            task,
            objective,
            model: options.model,
            dir: options.dir,
            bin: options.opencode,
            auto: options.auto,
          });
          refreshPanel();
          return done;
        },
      });
    } catch (error) {
      planFailed = true;
      const message = truncate(error?.message ?? String(error), 110);
      app.addLog(`! scheduler failure: ${message}`);
      app.applyEvent({ kind: 'status', from: 'orchestrator', text: `✗ scheduler failure: ${truncate(message, 70)}` });
    }
    offBus();
    if (stopped || token !== runToken) return;

    // --- Integration report: manifest conflicts from the plan (Phase 5 v1).
    let conflictsNote = null;
    try {
      const manifests = plan.map((task) => ({ taskId: task.id, files: task.files ?? [] }));
      const { conflicts } = detectConflicts(manifests);
      if (conflicts.length) {
        conflictsNote = `${conflicts.length} file conflict(s): ${conflicts.slice(0, 3).map((c) => `${c.file}(${c.taskIds.join(',')})`).join('; ')}`;
        app.addLog(`⚠ integration: ${conflictsNote} — review before merging`);
      }
    } catch {}
    // Persist for /resume (Phase 6 snapshot) into the run workspace.
    try {
      saveParallelState(options.dir || process.cwd(), {
        runId,
        objective,
        sequential: Boolean(options.sequential),
        tasks: plan,
        workers: manager.list(),
        counts: manager.counts(),
        plannerFallback: plannerWarn ? 'true' : null,
        conflicts: conflictsNote,
      });
    } catch {}

    activeRun = null;
    stopFormPolling();
    closeQuestionAtRunEnd();
    const counts = manager.counts();
    const doneCount = counts.completed;
    const badCount = counts.failed + counts.cancelled;
    const lastResult = [...manager.workers.values()].reverse().find((r) => r.output)?.output ?? '';
    if (planFailed || (doneCount === 0 && badCount > 0)) {
      const message = `parallel run: ${doneCount} completed, ${badCount} failed/cancelled`;
      app.finishRun('error', message);
      app.addLog(`! ${message}`);
      app.applyEvent({ kind: 'status', from: 'orchestrator', text: `✗ ${message}` });
    } else {
      const detail = truncate(lastResult.trim() || (plannerWarn ? `planner fallback · ${plannerWarn}` : ''), 70);
      app.finishRun(
        'done',
        `${plan.length} task(s) · ${doneCount} worker${doneCount === 1 ? '' : 's'}${conflictsNote ? ` · ⚠ ${truncate(conflictsNote, 40)}` : ''}`,
      );
      app.addLog(
        `✓ complete · ${plan.length} task(s) · ${doneCount} succeeded${detail ? ` · last: ${detail}` : ''}`,
      );
      app.applyEvent({
        kind: 'status',
        from: 'orchestrator',
        text: `✓ ${plan.length} task(s) complete in ${counts.completed}/${counts.total} workers`,
      });
    }
    abortRequested = false;
    app.setInputValue(lineInput?.value ?? '');
  };

  const startTask = async (raw) => {
    const rawValue = String(raw ?? '');
    // Preserve the prompt byte-for-byte except outer whitespace for emptiness check.
    // Inner newlines, indentation, Unicode are untouched.
    const task = rawValue.trim() ? rawValue.replace(/^\s+|\s+$/g, '') : '';
    if (!task) return;
    if (activeRun || preparingRun) {
      app.applyEvent({ kind: 'status', from: 'orchestrator', text: 'run active · press esc to abort' });
      return;
    }
    // Slash commands are handled before launching (and before touching the
    // run lifecycle), so they never spawn `opencode run`.
    if (task.startsWith('/')) {
      lineInput?.reset();
      app.setInputValue('');
      const [command, ...rest] = task.split(/\s+/);
  // Mutable fallback selector (TUI-editable). Seeded from CLI/env.
  if (!Array.isArray(options.fallbackModels)) options.fallbackModels = [];
  if (command === '/fallback') {
        const token = rest.join(' ').trim();
        if (!token) {
          app.addLog(`fallback models: ${options.fallbackModels.join(', ') || '(none — try /models)'}`);
          app.applyEvent({ kind: 'status', from: 'orchestrator', text: `fallback: ${options.fallbackModels.length} model(s)` });
          return;
        }
        if (token.toLowerCase() === 'clear') {
          options.fallbackModels = [];
          customFallbackModels = null;
          app.addLog('fallback models cleared');
        } else {
          options.fallbackModels = parseModelList(token);
          rememberCustoms();
          app.addLog(`fallback models set: ${options.fallbackModels.join(', ')}`);
        }
        app.applyEvent({ kind: 'status', from: 'orchestrator', text: `fallback: ${options.fallbackModels.length} model(s) · next task uses selector` });
        return;
      }
      if (command === '/models') {
        try {
          const { execFileSync } = await import('node:child_process');
          const out = execFileSync(options.opencode ?? process.env.FACTORY_OPENCODE ?? 'opencode', ['models'], { encoding: 'utf8', timeout: 15000 });
          const allLines = String(out).split('\n').map((l) => l.trim()).filter(Boolean);
          const goLines = allLines.filter((line) => line.startsWith('opencode-go/'));
          const lines = goLines.length > 0 ? goLines : allLines;
          app.addLog(goLines.length > 0
            ? 'models (opencode-go catalog; run picks in order):'
            : 'models (no opencode-go entries; showing full catalog):');
          lines.slice(0, 20).forEach((l) => app.addLog(` ${l}`));
          if (lines.length > 20) app.addLog(` … +${lines.length - 20} more`);
        } catch (error) {
          app.addLog(`! models: ${truncate(error?.message ?? String(error), 90)}`);
        }
        return;
      }
      if (command === '/new' || command === '/fresh') {
        currentSessionID = null;
        clearPersistedSession();
        app.addLog('fresh session — next task starts a new session');
        app.applyEvent({ kind: 'status', from: 'orchestrator', text: 'fresh session — next task starts a new session' });
        return;
      }
      if (command === '/sessions') {
        try {
          const sessions = listRootSessions({ dir: options.dir, limit: 12 });
          if (sessions.length === 0) {
            app.addLog('no root sessions found');
          } else {
            app.addLog('sessions (latest first):');
            sessions.forEach((session, index) => {
              const marker = currentSessionID && session.id === currentSessionID ? ' *current*' : '';
              app.addLog(`${index + 1}. ${truncate(session.id.slice(0, 20), 20)} · ${truncate(session.title || session.slug || '', 60)}${marker}`);
            });
            app.addLog('use /resume <id|#n> to continue one');
          }
          app.applyEvent({ kind: 'status', from: 'orchestrator', text: `sessions listed (${sessions.length}) · /resume to pick` });
        } catch (error) {
          const message = error?.message ?? String(error);
          app.addLog(`! sessions: ${truncate(message, 90)}`);
        }
        return;
      }
      if (command === '/resume') {
        const token = rest.join(' ').trim();
        if (!token) {
          app.addLog('! usage: /resume <id|#n>');
          return;
        }
        let nextID = token;
        if (/^\d+$/.test(token)) {
          try {
            const sessions = listRootSessions({ dir: options.dir, limit: 12 });
            const index = Number.parseInt(token, 10) - 1;
            if (sessions[index]) nextID = sessions[index].id;
          } catch (error) {
            const message = error?.message ?? String(error);
            app.addLog(`! resume lookup: ${truncate(message, 90)}`);
            return;
          }
        }
        currentSessionID = nextID;
        savePersistedSession({ sessionID: currentSessionID, dir: options.dir });
        app.addLog(`resume set: ${truncate(currentSessionID, 60)}`);
        app.applyEvent({ kind: 'status', from: 'orchestrator', text: `resume set: ${truncate(currentSessionID, 50)}` });
        return;
      }
      if (command === '/config') {
        rememberCustoms();
        app.openConfig(configSnapshot());
        return;
      }
      if (command === '/log') {
        app.openLog('orchestrator');
        return;
      }
      app.addLog(`! unknown command: ${command} (try /new, /sessions, /resume, /fallback, /models, /config, /log)`);
      return;
    }
    stopFormPolling();
    closeQuestionAtRunEnd();
    questionRequest = null;
    seenForms.clear();
    seenImages.clear();
    app.closeImage();
    lineInput?.reset();
    app.setInputValue('');
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    if (attachTimer) {
      clearTimeout(attachTimer);
      attachTimer = null;
    }
    source?.close();
    source = null;
    lastText = '';
    abortRequested = false;
    hadPermissionFailure = false;
    permissionFailureMessage = '';
    runToken += 1;
    const token = runToken;
    const resumed = Boolean(currentSessionID);
    app.startRun({
      sessionID: currentSessionID,
      resumed,
      parallel: options.parallel || options.sequential
        ? { workers: options.sequential ? 1 : (options.workers ?? 3) }
        : null,
    });
    if (options.parallel || options.sequential) {
      app.setParallelEnabled(true);
      app.addLog(`parallel mode: scheduler enabled (${options.sequential ? 1 : (options.workers ?? 3)} workers)`);
    }
    if (currentSessionID) {
      savePersistedSession({ sessionID: currentSessionID, dir: options.dir });
      startFormPolling();
    }
    preparingRun = true;
    app.addLog(`▶ ${truncate(task, 110)}`);
    app.applyEvent({ kind: 'status', from: 'orchestrator', text: `▶ ${truncate(task, 80)}` });
    if (options.auto === true) {
      const warn = '⚠ auto-approve ON: ask→allow, deny enforced — trusted unattended only';
      app.addLog(warn);
      app.applyEvent({ kind: 'status', from: 'orchestrator', text: warn });
    }
    if (usesNolimit(options)) {
      app.applyEvent({ kind: 'status', from: 'orchestrator', text: 'preparing built-in opencode-nolimit…' });
      const nolimit = await ensureNolimit();
      if (!nolimit.ok) {
        preparingRun = false;
        stopFormPolling();
        closeQuestionAtRunEnd();
        app.finishRun('error', nolimit.error);
        app.addLog(`! ${truncate(nolimit.error, 110)}`);
        return;
      }
    }
    let launchTask = task;
    let graphifyGuide = null;
    if (options.graphify) {
      const dir = options.dir || process.cwd();
      const graph = ensureGraphify(dir);
      if (graph.ok) {
        app.addLog('graphify: graph ready');
        launchTask = withGraphifyPrompt(task, dir);
        graphifyGuide = graphifyPrompt(dir);
      } else {
        const error = truncate(graph.error ?? 'graph unavailable', 90);
        app.addLog(`! graphify: ${error} — continuing without graph`);
      }
    }
    preparingRun = false;
    if (stopped || token !== runToken) return;

    // Parallel engine: plan + scheduler + independent workers (Phases 1–6).
    if (options.parallel || options.sequential) {
      await launchParallelRun(task, token, graphifyGuide);
      return;
    }

    let handle;
    try {
      handle = launchRun({
        task: launchTask,
        model: options.model,
        fallbackModels: options.fallbackModels ?? [],
        auto: options.auto,
        dir: options.dir,
        bin: options.opencode,
        sessionID: currentSessionID,
        onSpawn: (pid) => {
          if (token === runToken && !stopped) app.setRunPid(pid);
        },
        onSessionID: (id) => {
          if (token !== runToken || stopped) return;
          currentSessionID = id;
          savePersistedSession({ sessionID: id, dir: options.dir });
          app.setRunSession(id);
          startFormPolling();
        },
        onEvent: (parsed) => {
          if (token === runToken && !stopped) handleParsed(parsed);
        },
        onExit: (result) => {
          if (token === runToken) finishTask(result);
        },
        onError: () => {},
      });
    } catch (error) {
      const message = error?.message ?? String(error);
      stopFormPolling();
      closeQuestionAtRunEnd();
      app.finishRun('error', message);
      app.addLog(`! ${truncate(message, 110)}`);
      return;
    }
    activeRun = handle;
    if (handle.child?.pid) app.setRunPid(handle.child.pid);
  };

  const onKey = (buffer) => {
    const raw = buffer.toString('utf8');
    // SGR mouse reporting: left-click on an agent's "msg: n" line opens its log.
    const mousePattern = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
    let mouseOnly = false;
    let hadMouse = false;
    const text = raw.replace(mousePattern, (_, button, x, y, type) => {
      hadMouse = true;
      if (type === 'M' && button === '0'
          && !app.questionView?.open && !app.imageView?.open) {
        const key = app.hitAgentMsg(Number(x), Number(y));
        if (key) app.openLog(key);
      }
      return '';
    });
    if (hadMouse && text.trim() === '') return;
    // Questions consume every key first: in particular Esc cancels the form,
    // never the underlying run. API actions stay asynchronous to rendering.
    if (app.questionView.open) {
      if (questionRequest) return;
      const action = app.handleQuestionKey(buffer);
      if (action?.action === 'reply') void answerQuestion(action.answer);
      else if (action?.action === 'cancel') cancelQuestion();
      else if (action?.action === 'external') openExternal(action.url);
      return;
    }
    if (app.imageView.open) {
      if (text === 'o' || text === 'O') {
        const image = app.imageView.image;
        openExternal(image?.path ?? image?.url ?? image?.uri);
      } else if (text === '\x1b' || text === 'q' || text === 'Q') app.closeImage();
      return;
    }
    // Log overlay consumes keys first so Esc never aborts a run from inside it.
    if (app.logView.open) {
      if (text === '\x1b' || text === 'q' || text === 'Q') app.closeLog();
      else if (text === '\x1b[C') app.cycleLogAgent(1);
      else if (text === '\x1b[D') app.cycleLogAgent(-1);
      else if (text === '\x1b[A') app.scrollLog(-1);
      else if (text === '\x1b[B') app.scrollLog(1);
      else if (text.length === 1 && text >= '1' && text <= '6') {
        app.openLog(AGENT_ORDER[Number(text) - 1]);
      }
      // Anything else is swallowed while the overlay is open.
      return;
    }
    // Config overlay: rows, q/Esc close, other keys are swallowed.
    if (app.configView.open) {
      if (text === '\x1b' || text === 'q' || text === 'Q') app.closeConfig();
      else if (text === '\x1b[A') app.moveConfigSelection(-1);
      else if (text === '\x1b[B') app.moveConfigSelection(1);
      else if (text === '\r' || text === '\n' || text === '\x1b[C') applyConfigChange(app.configView.selected, 1);
      else if (text === '\x1b[D') applyConfigChange(app.configView.selected, -1);
      return;
    }
    if (mode === 'task') {
      // `/log` opens the log viewer even while a task is running. Bare `l` is
      // no longer a shortcut here, so typing a task that starts with L works.
      if ((text === '\r' || text === '\n') && lineInput.value.trim() === '/log') {
        lineInput.reset();
        app.setInputValue('');
        app.openLog('orchestrator');
        return;
      }
      for (const action of lineInput.handle(buffer)) {
        if (action.type === 'quit') {
          stop(0);
          return;
        }
        if (action.type === 'abort') abortTask();
        else if (action.type === 'submit') startTask(action.value);
      }
      app.setInputValue(lineInput.value);
      return;
    }
    if (text === 'l' || text === 'L') {
      app.openLog('orchestrator');
      return;
    }
    if (text.includes('\u0003')) stop(0);
    else if (text.includes('q')) stop(0);
  };

  const onSigint = () => stop(0);
  const onResize = () => {
    const nextWidth = out.columns || width;
    const nextHeight = out.rows || height;
    if (nextWidth < MIN_WIDTH || nextHeight < MIN_HEIGHT) {
      small = true;
      stop(1);
      return;
    }
    app.resize(nextWidth, nextHeight);
  };

  try {
    if (mode === 'live') {
      source = new LiveSource({ session: options.session, dir: options.dir, limit: options.limit });
      source.open();
      applySessionCounts(app, source);
    }

    out.write('\x1b[?1049h\x1b[?25l\x1b[2J\x1b[H');
    screenEntered = true;
    // Enable bracketed paste and SGR mouse reporting (click-to-open agent logs).
    try { out.write('\x1b[?2004h'); } catch {}
    try { out.write('\x1b[?1000h\x1b[?1006h'); } catch {}
    out.write(app.frame());
    if (input.isTTY) {
      input.setRawMode(true);
      input.resume();
      raw = true;
    }
    input.on('data', onKey);
    process.on('SIGINT', onSigint);
    out.on('resize', onResize);

    let last = performance.now();
    if (!stopped) {
      renderTimer = setInterval(() => {
        if (stopped) return;
        try {
          const now = performance.now();
          const delta = Math.min(250, now - last);
          last = now;
          app.advance(delta);
          out.write(app.frame());
        } catch (error) {
          fatal = error;
          stop(1);
        }
      }, Math.round(1000 / FPS));

      if (mode === 'task') {
        app.addLog('ready · type a task below');
        app.applyEvent({ kind: 'status', from: 'orchestrator', text: 'ready · type a task below' });
      } else if (mode === 'demo') {
        demoHandle = playDemo(app, {
          onDone: () => {
            app.applyEvent({ kind: 'status', from: 'orchestrator', text: 'demo complete · press q' });
          },
        });
      } else {
        const follow = options.follow ?? true;
        void (async () => {
          try {
            const events = source.loadBackfill();
            app.applyEvent({
              kind: 'status',
              from: 'orchestrator',
              text: `replaying ${events.length} events · ${follow ? 'follow on' : 'follow off'}`,
            });
            const tick = options.fast ? 40 : Math.max(20, options.packetSpeed);
            for (const event of events) {
              if (stopped) return;
              app.applyEvent(event);
              await delay(tick);
            }
            if (stopped) return;
            app.applyEvent({
              kind: 'status',
              from: 'orchestrator',
              text: follow ? 'history loaded · following new messages' : 'history complete · press q',
            });
            if (!follow) return;

            let polling = false;
            pollTimer = setInterval(async () => {
              if (stopped || polling) return;
              polling = true;
              try {
                for (const event of source.poll()) {
                  if (stopped) break;
                  app.applyEvent(event);
                }
              } catch (error) {
                app.applyEvent({
                  kind: 'status',
                  from: 'orchestrator',
                  text: `db poll error: ${truncate(error?.message ?? String(error), 60)}`,
                });
              } finally {
                polling = false;
              }
            }, 1000);
          } catch (error) {
            if (!stopped) {
              app.applyEvent({
                kind: 'status',
                from: 'orchestrator',
                text: `live error: ${truncate(error?.message ?? String(error), 60)}`,
              });
            }
          }
        })();
      }
    }

    const code = await done;
    if (small) {
      process.stderr.write(
        `theFactory needs a terminal of at least ${MIN_WIDTH}x${MIN_HEIGHT} (got ${out.columns || width}x${out.rows || height}).\n`,
      );
    }
    if (fatal) {
      process.stderr.write(`thefactory: ${fatal.message ?? String(fatal)}\n`);
    }
    return code;
  } finally {
    restore();
  }
}

/** CLI entry point. Returns the process exit code. */
export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (options.version) {
    process.stdout.write(`thefactory ${version}\n`);
    return 0;
  }
  if (options.nolimit) return nolimitCommand(options.nolimit);
  if (options.resume != null) {
    const { loadParallelState, resumePlan } = await import('./parallelState.js');
    const saved = loadParallelState(options.resume);
    if (!saved) {
      process.stdout.write(`No parallel state in ${options.resume} (nothing to resume).\n`);
      return 1;
    }
    const plan = resumePlan(saved, new Set());
    process.stdout.write(`Resume plan from ${options.resume}:\n`);
    process.stdout.write(`  resumable (read-only/idempotent): ${plan.resumable.length}\n`);
    for (const r of plan.resumable) process.stdout.write(`   - ${r.taskId} (${r.reason})\n`);
    process.stdout.write(`  needs review (write tasks, not auto-rerun): ${plan.needsReview.length}\n`);
    for (const r of plan.needsReview) process.stdout.write(`   - ${r.taskId} (${r.reason}): ${r.note}\n`);
    process.stdout.write(`  interrupted workers: ${plan.interrupted.length}\n`);
    return 0;
  }

  const isTTY = Boolean(process.stdout.isTTY);
  let mode = chooseMode(options, isTTY);

  if (mode === 'list') return runList(options);

  if (mode === 'task' && (!isTTY || options.snapshot != null)) {
    process.stderr.write(
      'thefactory: task mode needs an interactive TTY (try --demo or --live --snapshot).\n',
    );
    return 1;
  }

  if (mode === 'picker' && !isTTY) {
    process.stderr.write('thefactory: --picker needs an interactive TTY.\n');
    return 1;
  }

  const wantsPicker =
    isTTY &&
    options.snapshot == null &&
    (mode === 'picker' || (mode === 'live' && !options.session));
  if (wantsPicker) {
    const session = await pickSession(options);
    if (!session) return 0;
    options.session = session;
    mode = 'live';
  }

  if (mode === 'picker') {
    process.stderr.write('thefactory: --picker is interactive; use --session for snapshots.\n');
    return 1;
  }

  if (options.snapshot != null || !isTTY) {
    return runSnapshot(mode, options, options.snapshot ?? 1);
  }
  return runTui(mode, options);
}

/** Show a configuration card in the TUI log overlay. */
function showConfigCard(app, options) {
  const model = options.model || '(none)';
  const fallbacks = options.fallbackModels
    ? options.fallbackModels.join(', ')
    : '(none)';
  const auto = options.auto === true ? 'ON' : 'OFF';
  const parallel = options.parallel ? `${options.workers || 3}w` : 'OFF';
  const sequential = options.sequential ? 'ON' : 'OFF';
  const dir = options.dir || process.cwd();
  const session = options.session || '(none)';
  const nolimit = options.nolimit || '(disabled)';

  return runTui(mode, options);
}
