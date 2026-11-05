#!/usr/bin/env node
/**
 * CLI entry: argument parsing, picker, snapshot output, and the TTY event loop.
 */

import process from 'node:process';
import * as readlinePromises from 'node:readline/promises';
import { readFileSync } from 'node:fs';
import { App } from './app.js';
import { truncate } from './canvas.js';
import { demoEvents, playDemo } from './demo.js';
import { LineInput } from './input.js';
import { LiveSource, listRootSessions } from './live.js';
import { MIN_HEIGHT, MIN_WIDTH } from './layout.js';
import { launchRun } from './run.js';
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
  --attach <id|slug>     alias for --session (live mode)
  --session <id|slug>    select a session by exact id, id prefix, or slug
  --dir <path>           prefer sessions in this directory; task cwd
  --model <model#var>    forwarded to opencode run as -m
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

Keys in task mode: type a task, Enter submits, Backspace edits, Esc aborts a
running task, Ctrl-C always quits, q quits only when the prompt is empty.
The visualizer needs at least ${MIN_WIDTH}x${MIN_HEIGHT}.`;

/** Parse the small, dependency-free flag set. */
export function parseArgs(argv) {
  const options = {
    mode: null,
    snapshot: null,
    session: null,
    dir: null,
    limit: 200,
    follow: null,
    packetSpeed: 400,
    fast: false,
    model: null,
    opencode: null,
    task: null,
    help: false,
    version: false,
    nolimit: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--demo') options.mode = 'demo';
    else if (arg === '--live') options.mode = 'live';
    else if (arg === '--task') options.mode = 'task';
    else if (arg === '--picker') options.mode = 'picker';
    else if (arg === '--list') options.mode = 'list';
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
  let killTimer = null;
  let attachTimer = null;
  let lastText = '';
  let runToken = 0;
  const lineInput = mode === 'task' ? new LineInput(options.task ?? '') : null;
  if (lineInput) app.setInputValue(lineInput.value);
  let finish;
  const done = new Promise((resolve) => {
    finish = resolve;
  });

  const restore = () => {
    if (restored) return;
    restored = true;
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
      app.setRunSession(parsed.sessionID);
      attachRoot(parsed.sessionID);
    }
    if (parsed.text) {
      lastText = parsed.text;
      app.addLog(`▸ ${truncate(parsed.text, 110)}`);
    }
    for (const event of parsed.events) app.applyEvent(event);
    if (parsed.error) app.addLog(`! ${truncate(parsed.error, 100)}`);
  };

  const finishTask = (result) => {
    activeRun = null;
    if (killTimer) {
      clearTimeout(killTimer);
      killTimer = null;
    }
    if (stopped) return;
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
    const task = String(raw ?? '').trim();
    if (!task) return;
    if (activeRun || preparingRun) {
      app.applyEvent({ kind: 'status', from: 'orchestrator', text: 'run active · press esc to abort' });
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
    runToken += 1;
    const token = runToken;
    app.startRun({});
    preparingRun = true;
    app.addLog(`▶ ${truncate(task, 110)}`);
    app.applyEvent({ kind: 'status', from: 'orchestrator', text: `▶ ${truncate(task, 80)}` });
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
        dir: options.dir,
        bin: options.opencode,
        onSpawn: (pid) => {
          if (token === runToken && !stopped) app.setRunPid(pid);
        },
        onSessionID: (id) => {
          if (token === runToken && !stopped) app.setRunSession(id);
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
    if (mode === 'task') {
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
    const text = buffer.toString('utf8');
    if (text.includes('q') || text.includes('\u0003')) stop(0);
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
