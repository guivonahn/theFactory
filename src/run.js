/**
 * Task launcher: spawn `opencode run --format json` and map its JSONL stream
 * into tolerant, app-level events. No npm dependencies.
 */

import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { resolveAgent } from './agents.js';

const STDERR_TAIL = 2000;

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function tail(value, max = 160) {
  const text = clean(value);
  if (!text) return '';
  return text.length <= max ? text : `…${text.slice(-max)}`;
}

function parseJson(line) {
  try {
    const value = JSON.parse(line);
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

/**
 * Parse one `opencode run --format json` line.
 * Always returns `{ sessionID, type, text, tool, error, events }` or null for
 * garbage/blank lines. Unknown event types are ignored except for the
 * sessionID capture, which is the important live-attach signal.
 */
export function parseRunLine(line) {
  const raw = String(line ?? '').trim();
  if (!raw) return null;
  const data = parseJson(raw);
  if (!data) return null;

  const part = data.part && typeof data.part === 'object' ? data.part : {};
  const sessionID =
    typeof data.sessionID === 'string'
      ? data.sessionID
      : typeof part.sessionID === 'string'
        ? part.sessionID
        : null;
  const type =
    typeof data.type === 'string' ? data.type : typeof part.type === 'string' ? part.type : null;

  const result = { sessionID, type, text: null, tool: null, error: null, events: [] };

  if (type === 'text' || part.type === 'text') {
    const text = clean(typeof part.text === 'string' ? part.text : data.text);
    if (text) {
      result.text = text;
      result.events.push({ kind: 'status', from: 'orchestrator', text: `▸ ${tail(text, 120)}` });
    }
    return result;
  }

  if (type === 'tool' || part.type === 'tool') {
    const tool = clean(
      part.tool ?? part.name ?? part.state?.tool ?? part.state?.title ?? data.tool ?? 'tool',
    );
    const input = part.state?.input ?? part.input ?? part.state?.metadata ?? {};
    const rawAgent =
      input && typeof input === 'object'
        ? (input.agent ?? input.subagent_type ?? input.agent_type ?? input.subagent ?? null)
        : null;
    const target = rawAgent ? resolveAgent(rawAgent) : null;
    const fanout = /subagent|task/i.test(tool);
    result.tool = tool;
    result.events.push({
      kind: 'tool',
      from: 'orchestrator',
      text: tool,
      fanout,
      to: target && target.key !== 'other' ? target.key : null,
    });
    return result;
  }

  if (type === 'error' || data.error) {
    const error = clean(
      data.error?.message ?? data.message ?? part.text ?? part.state?.error ?? data.error ?? '',
    );
    result.error = error || 'run error';
    result.events.push({ kind: 'status', from: 'orchestrator', text: `⚠ ${tail(result.error, 100)}` });
    return result;
  }

  // step_start / step_finish / synthetic / unknown: only the sessionID matters.
  return result;
}

/**
 * Build the `opencode run` argv for the given options.
 * Session handling: `sessionID` → `--session <id>`; `continue` (without an id)
 * → `--continue`; `fresh`/`newSession` → neither (brand-new session).
 * With no session options the default is a brand-new session (backward compatible).
 */
export function argsForRun(options = {}) {
  const task = String(options.task ?? '');
  const args = ['run', '--format', 'json'];
  if (options.sessionID) args.push('--session', options.sessionID);
  else if (options.continue) args.push('--continue');
  if (options.model) args.push('-m', options.model);
  args.push(task);
  return args;
}

/**
 * Launch one real OpenCode turn.
 * Returns `{ child, done, onEvent(), sessionID(), stderrTail, kill() }`.
 * Events are delivered through callbacks so the caller never blocks the render
 * loop; `onEvent()` can also be registered after launch and receives the events
 * parsed so far. `bin`/`opencode` both override the binary.
 */
export function launchRun(options = {}) {
  const command = options.bin || options.opencode || process.env.FACTORY_OPENCODE || 'opencode';
  const args = argsForRun(options);

  const child = spawn(command, args, {
    cwd: options.dir || process.cwd(),
    env: { ...process.env, ...(options.env ?? {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });

  let sessionID = null;
  let stderrTail = '';
  let spawnError = null;
  const listeners = new Set();
  const received = [];

  const emit = (parsed) => {
    received.push(parsed);
    if (received.length > 500) received.shift();
    for (const listener of listeners) {
      try {
        listener(parsed);
      } catch (error) {
        options.onError?.(error);
      }
    }
  };

  if (child.stdout) {
    const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on('line', (line) => {
      const parsed = parseRunLine(line);
      if (!parsed) return;
      if (parsed.sessionID && !sessionID) {
        sessionID = parsed.sessionID;
        options.onSessionID?.(sessionID);
      }
      try {
        options.onEvent?.(parsed);
      } catch (error) {
        options.onError?.(error);
      }
      emit(parsed);
    });
    child.once('close', () => lines.close());
  }

  if (child.stderr) {
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderrTail = `${stderrTail}${chunk}`.slice(-STDERR_TAIL);
      options.onStderr?.(stderrTail);
    });
  }

  child.once('spawn', () => options.onSpawn?.(child.pid));
  child.once('error', (error) => {
    spawnError = error;
    options.onError?.(error);
  });

  const done = new Promise((resolve) => {
    child.once('close', (code, signal) => {
      resolve({ code, signal, stderr: stderrTail, error: spawnError });
    });
  });
  done.then((result) => options.onExit?.(result)).catch(() => {});

  const handle = {
    child,
    onEvent(callback) {
      if (typeof callback === 'function') {
        for (const event of received) {
          try {
            callback(event);
          } catch (error) {
            options.onError?.(error);
          }
        }
        listeners.add(callback);
      }
      return handle;
    },
    sessionID() {
      return sessionID;
    },
    get sessionId() {
      return sessionID;
    },
    get stderrTail() {
      return stderrTail;
    },
    done,
    onExit(callback) {
      done.then(callback).catch(() => {});
      return handle;
    },
    kill(signal = 'SIGTERM') {
      if (child.exitCode !== null || child.signalCode) return false;
      try {
        return child.kill(signal);
      } catch {
        return false;
      }
    },
  };
  return handle;
}
