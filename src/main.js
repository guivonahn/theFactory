#!/usr/bin/env node
/**
 * CLI entry: argument parsing, picker, snapshot output, and the TTY event loop.
 */

import process from 'node:process';
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
import {
  clearPersistedSession,
  loadPersistedSession,
  savePersistedSession,
} from './sessionState.js';
import { ensureNolimit, nolimitCommand } from './nolimit.js';

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
  --fallback-models <csv> comma-separated fallback models tried in order on quota/no-route (bounded, env FACTORY_FALLBACK_MODELS)
  --auto                 auto-approve opencode ask permissions via --auto (explicit opt-in for trusted unattended only; deny stays enforced)
  --no-auto              do not pass --auto (default); ask rules are auto-rejected headlessly (surfaced as ⚠, never silent success)
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
  /models                list free + nolimit models available for fallback

Keys in task mode: type a task, Enter submits, Backspace edits, Esc aborts a
running task, Ctrl-C always quits, q quits only when the prompt is empty.
Keys in all TUI modes: l opens the log viewer (task mode: only when the
composer is empty, so typing l mid-task still works). In the log viewer:
←/→ cycle agent (orchestrator + 6 pillars + other), ↑/↓ scroll, 1-6 jump to
explorer/architect/developer/reviewer/security/tester, Esc closes.
The visualizer needs at least ${MIN_WIDTH}x${MIN_HEIGHT}.

Session persistence (task mode): the last session id is saved to
$XDG_STATE_HOME/thefactory/session.json (or ~/.local/state/thefactory/session.json)
and resumes automatically when the working directory matches. Use --new or /new to
start fresh.`;

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
    auto: false,
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
    if (screenEntered) out.write('\x1b[0m\x1b[?25h\x1b[?1049l');
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
    if (killTimer) {
      clearTimeout(killTimer);
      killTimer = null;
    }
    if (stopped) return;
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
      app.addLog(`! ${truncate(message, 110)}`);
      app.applyEvent({ kind: 'status', from: 'orchestrator', text: `✗ ${truncate(message, 80)}` });
    } else if (abortRequested) {
      app.finishRun('aborted');
      app.addLog(`■ aborted after ${elapsed}s`);
      app.applyEvent({ kind: 'status', from: 'orchestrator', text: '■ task aborted' });
    } else if (result.code === 0 && hadPermissionFailure) {
      const message = permissionFailureMessage || 'permission denied — see log';
      app.finishRun('error', message);
      app.addLog(`! ${truncate(message, 110)}`);
      app.applyEvent({ kind: 'status', from: 'orchestrator', text: `✗ permission failure: ${truncate(message, 80)}` });
    } else if (result.code === 0) {
      const detail = lastText.trim();
      app.finishRun('done', detail);
      app.addLog(`✓ complete in ${elapsed}s${detail ? ` · ${truncate(detail, 80)}` : ''}`);
      app.applyEvent({
        kind: 'status',
        from: 'orchestrator',
        text: `✓ task complete in ${Math.max(1, elapsed)}s`,
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
      app.addLog(`! ${truncate(message, 110)}`);
      app.applyEvent({ kind: 'status', from: 'orchestrator', text: `✗ ${truncate(message, 80)}` });
    }
    abortRequested = false;
    app.setInputValue(lineInput?.value ?? '');
  };

  const abortTask = () => {
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
          app.addLog('fallback models cleared');
        } else {
          options.fallbackModels = parseModelList(token);
          app.addLog(`fallback models set: ${options.fallbackModels.join(', ')}`);
        }
        app.applyEvent({ kind: 'status', from: 'orchestrator', text: `fallback: ${options.fallbackModels.length} model(s) · next task uses selector` });
        return;
      }
      if (command === '/models') {
        try {
          app.addLog('models (run picks in order; * = nolimit):');
          const { execFileSync } = await import('node:child_process');
          const out = execFileSync(options.opencode ?? process.env.FACTORY_OPENCODE ?? 'opencode', ['models'], { encoding: 'utf8', timeout: 15000 });
          const lines = String(out).split('\n').map((l) => l.trim()).filter(Boolean);
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
      app.addLog(`! unknown command: ${command} (try /new, /sessions, /resume, /fallback, /models)`);
      return;
    }
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
      parallel: options.parallel ? { workers: options.sequential ? 1 : (options.workers ?? 3) } : null,
    });
    if (options.parallel || options.sequential) {
      app.setParallelEnabled(true);
      app.setParallelWorkers([{ workerId: 'w_main', taskId: 'main', role: 'orchestrator', sessionId: currentSessionID, state: 'running' }]);
      app.addLog(`parallel mode: scheduler enabled (${options.sequential ? 1 : (options.workers ?? 3)} workers)`);
    }
    if (currentSessionID) {
      savePersistedSession({ sessionID: currentSessionID, dir: options.dir });
    }
    preparingRun = true;
    app.addLog(`▶ ${truncate(task, 110)}`);
    app.applyEvent({ kind: 'status', from: 'orchestrator', text: `▶ ${truncate(task, 80)}` });
    if (options.auto === true) {
      const warn = '⚠ auto-approve ON: ask→allow, deny enforced — trusted unattended only';
      app.addLog(warn);
      app.applyEvent({ kind: 'status', from: 'orchestrator', text: warn });
    }
    app.applyEvent({ kind: 'status', from: 'orchestrator', text: 'preparing built-in opencode-nolimit…' });
    const nolimit = await ensureNolimit();
    preparingRun = false;
    if (!nolimit.ok) {
      app.finishRun('error', nolimit.error);
      app.addLog(`! ${truncate(nolimit.error, 110)}`);
      return;
    }
    if (stopped || token !== runToken) return;

    let handle;
    try {
      handle = launchRun({
        task,
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
      app.finishRun('error', message);
      app.addLog(`! ${truncate(message, 110)}`);
      return;
    }
    activeRun = handle;
    if (handle.child?.pid) app.setRunPid(handle.child.pid);
  };

  const onKey = (buffer) => {
    const text = buffer.toString('utf8');
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
    if (mode === 'task') {
      // Bare `l` opens the log only on an empty composer, so typing l
      // mid-task still types.
      if ((text === 'l' || text === 'L') && lineInput.value === '') {
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
    // Enable bracketed paste (terminals send \x1b[200~ … \x1b[201~ markers,
    // letting LineInput insert multi-line pastes verbatim without submitting).
    try { out.write('\x1b[?2004h'); } catch {}
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
