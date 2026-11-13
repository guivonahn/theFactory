/**
 * Task launcher: spawn `opencode run --format json` and map its JSONL stream
 * into tolerant, app-level events. No npm dependencies.
 */

import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { resolveAgent } from './agents.js';
import { imagesFromPart } from './media.js';
import { coarenaModels, coarenaRunEnv, isCoarenaModel, usesCoarena } from './coarena.js';
import { agentModelsRunEnv, hasAgentModels, MODEL_AGENT_KEYS } from './agentModels.js';
import { toolLogEntry } from './logFormat.js';

const STDERR_TAIL = 2000;

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function tail(value, max = 160) {
  const text = clean(value);
  if (!text) return '';
  return text.length <= max ? text : `…${text.slice(-max)}`;
}

export function toolDetail(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return '';
  for (const key of ['command', 'script', 'cmd']) {
    const value = input[key];
    if (Array.isArray(value)) {
      const command = tail(value.join(' '), 100);
      if (command) return command;
    } else {
      const command = tail(value, 100);
      if (command) return command;
    }
  }
  for (const key of ['filePath', 'path', 'file', 'pattern', 'title', 'description']) {
    const detail = tail(input[key], 100);
    if (detail) return detail;
  }
  return '';
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

  const result = {
    sessionID,
    type,
    text: null,
    tool: null,
    error: null,
    permission: null,
    events: [],
    images: [],
  };
  const logMeta = { timestamp: typeof data.timestamp === 'number' ? data.timestamp : undefined, sessionID, model: typeof data.model === 'string' ? data.model : undefined };

  // Detect images before any event-specific early return. Tool output is
  // external data, so malformed metadata must never make JSONL parsing fail.
  try {
    result.images = imagesFromPart(part, { text: part.text ?? data.text });
  } catch {
    result.images = [];
  }

  // Future-proof permission-request signal: handle explicitly so it is never
  // dropped silently. `opencode run --format json` currently reports ask
  // rejections only via stderr (`! permission requested: ...; auto-rejecting`)
  // plus a tool_use `state.error`, but a structured permission event must
  // survive parsing if the format ever emits one.
  const typeStr = typeof data.type === 'string' ? data.type : '';
  const partTypeStr = typeof part.type === 'string' ? part.type : '';
  const permSource =
    data.permission && typeof data.permission === 'object'
      ? data.permission
      : part.permission && typeof part.permission === 'object'
        ? part.permission
        : null;
  if (
    typeStr.includes('permission') ||
    partTypeStr.includes('permission') ||
    permSource
  ) {
    const rawMessage = clean(
      permSource?.message ?? data.message ?? part.message ?? part.text ?? data.text ?? '',
    );
    const fromMessage = rawMessage.match(/permission requested:\s*([^\s;(]+)\s*\(([^)]+)\)/i);
    const action = clean(
      permSource?.action ?? data.action ?? part.action ?? part.tool ?? part.name ?? fromMessage?.[1] ?? 'permission',
    );
    const pattern = clean(
      permSource?.pattern ?? data.pattern ?? part.pattern ?? fromMessage?.[2] ?? rawMessage ?? '',
    );
    result.permission = { action: action || 'permission', pattern: pattern || null };
    const suffix = pattern ? ` (${pattern})` : '';
    result.events.push({
      kind: 'status',
      from: 'orchestrator',
      text: `⚠ permission requested: ${result.permission.action}${suffix}`,
    });
    return result;
  }

  if (type === 'text' || part.type === 'text') {
    const text = String(typeof part.text === 'string' ? part.text : data.text ?? '').replace(/\r\n/g, '\n');
    if (text.trim()) {
      result.text = text;
      result.logEntry = { id: part.id, kind: 'message', dir: 'in', text, ...logMeta };
      result.events.push({ kind: 'status', from: 'orchestrator', text: `▸ ${tail(text, 120)}` });
    }
    return result;
  }

  if (
    type === 'tool' ||
    type === 'tool_use' ||
    part.type === 'tool' ||
    part.type === 'tool_use'
  ) {
    const tool = clean(
      part.tool ?? part.name ?? part.state?.tool ?? part.state?.title ?? data.tool ?? 'tool',
    );
    result.logEntry = toolLogEntry(part, logMeta);
    // A tool_use error (deny/ask auto-reject) must surface as an error +
    // a visible status instead of a silent tool event. This is the primary
    // headless failure: stderr says "permission requested; auto-rejecting"
    // while JSONL only carries `Tool execution interrupted` / deny text.
    if (part.state?.status === 'error') {
      const errorText = clean(part.state?.error ?? part.state?.message ?? data.error ?? '');
      result.tool = tool;
      result.error = errorText || 'tool error';
      if (/permission denied/i.test(result.error)) {
        result.events.push({
          kind: 'status',
          from: 'orchestrator',
          text: `⚠ Permission denied: ${tool}`,
        });
      } else if (/tool execution interrupted|permission requested/i.test(result.error)) {
        result.events.push({
          kind: 'status',
          from: 'orchestrator',
          text: `⚠ Permission interrupted: ${tool}: ${tail(result.error, 80)}`,
        });
      } else {
        result.events.push({
          kind: 'status',
          from: 'orchestrator',
          text: `✗ ${tool}: ${tail(result.error, 80)}`,
        });
      }
      return result;
    }
    const input = part.state?.input ?? part.input ?? part.state?.metadata ?? {};
    const detail = toolDetail(input);
    const rawAgent =
      input && typeof input === 'object'
        ? (input.agent ?? input.subagent_type ?? input.agent_type ?? input.subagent ?? null)
        : null;
    const target = rawAgent ? resolveAgent(rawAgent) : null;
    const fanout = /subagent|task/i.test(tool);
    result.tool = tool;
    result.events.push({
      kind: 'tool',
      logEntry: result.logEntry,
      from: 'orchestrator',
      text: detail ? `${tool}: ${detail}` : tool,
      fanout,
      to: target && target.key !== 'other' ? target.key : null,
    });
    // Capture a compact diff for edit/write tools so theFactory can display
    // the actual code change, indented and formatted, in the log.
    const isEdit = /edit|write/i.test(tool);
    if (isEdit && input && typeof input === 'object') {
      const lines = [];
      if (typeof input.oldString === 'string' && input.oldString) {
        for (const l of String(input.oldString).split('\n').slice(0, 12)) lines.push(`    - ${l}`);
      }
      if (typeof input.newString === 'string' && input.newString) {
        for (const l of String(input.newString).split('\n').slice(0, 12)) lines.push(`    + ${l}`);
      }
      if (lines.length === 0 && typeof input.content === 'string' && input.content) {
        for (const l of String(input.content).split('\n').slice(0, 12)) lines.push(`    + ${l}`);
      }
      if (lines.length > 0) {
        result.diff = `${tool}: ${detail || ''}\n${lines.join('\n')}`.trim();
      }
    }
    return result;
  }

  if (type === 'error' || data.error) {
    const error = clean(
      data.error?.message ?? data.error?.data?.message ?? data.message ?? part.text ?? part.state?.error ?? (typeof data.error === 'object' ? JSON.stringify(data.error) : data.error) ?? '',
    );
    result.error = error || 'run error';
    result.logEntry = { kind: 'error', text: result.error, ...logMeta };
    result.events.push({ kind: 'status', from: 'orchestrator', text: `⚠ ${tail(result.error, 100)}` });
    return result;
  }

  if (type === 'step_finish' && part.tokens) {
    const { input, output } = part.tokens;
    if (Number.isFinite(input) && Number.isFinite(output)) {
      result.logEntry = { kind: 'status', text: `Usage: ${input} input · ${output} output${Number.isFinite(part.cost) ? ` · $${part.cost.toFixed(4)}` : ''}`, tokens: input + output, ...logMeta };
    }
  }

  // step_start / step_finish / synthetic / unknown: only the sessionID matters.
  return result;
}

/**
 * Build the `opencode run` argv for the given options.
 * Session handling: `sessionID` → `--session <id>`; `continue` (without an id)
 * → `--continue`; `fresh`/`newSession` → neither (brand-new session).
 * With no session options the default is a brand-new session (backward compatible).
 * Permission handling: `auto` defaults to false (safe). `--auto` is explicit
 * opt-in for trusted unattended executions: it auto-approves `ask` rules;
 * `deny` rules remain enforced. Without `--auto` an `ask` match aborts
 * headlessly with `! permission requested: ...; auto-rejecting` (surfaced
 * as `⚠ permission requested` instead of an opaque failure).
 */
export function argsForRun(options = {}) {
  const task = String(options.task ?? '');
  const auto = options.auto === true;
  const args = ['run', '--format', 'json'];
  if (usesCoarena(options) || hasAgentModels(options)) args.push('--standalone');
  if (auto) args.push('--auto');
  if (options.sessionID) args.push('--session', options.sessionID);
  else if (options.continue) args.push('--continue');
  if (options.model) args.push('-m', options.model);
  if (options.agent) args.push('--agent', String(options.agent));
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

  let env = { ...process.env, ...(options.env ?? {}) };
  const allAgents = !hasAgentModels(options) && (isCoarenaModel(options.model) || options.coarena && options.fallbackAttempt);
  if (usesCoarena(options)) env = coarenaRunEnv(env, options.model, { allAgents });
  if (hasAgentModels(options)) env = agentModelsRunEnv(env, options.model, options.agentModels, options.fallbackAttempt, options.agent ?? 'orchestrator');
  const child = spawn(command, args, {
    cwd: options.dir || process.cwd(),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });

  let sessionID = null;
  let stderrTail = '';
  let spawnError = null;
  const listeners = new Set();
  const received = [];
  const seenPermissions = new Set();

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
    let stderrBuffer = '';
    let stderrFlushed = false;

    const emitPermission = (action, permissionPattern) => {
      const key = `${action}:${permissionPattern ?? ''}`;
      if (seenPermissions.has(key)) return;
      seenPermissions.add(key);
      const synthetic = {
        sessionID: null,
        type: 'permission',
        text: null,
        tool: null,
        error: null,
        permission: { action, pattern: permissionPattern },
        events: [
          {
            kind: 'status',
            from: 'orchestrator',
            text: `⚠ permission requested: ${action}${permissionPattern ? ` (${permissionPattern})` : ''}`,
          },
        ],
      };
      try {
        options.onEvent?.(synthetic);
      } catch (error) {
        options.onError?.(error);
      }
      emit(synthetic);
      try {
        options.onPermission?.(synthetic.permission, synthetic);
      } catch (error) {
        options.onError?.(error);
      }
    };

    const processStderrLine = (line) => {
      if (!/permission requested/i.test(line)) return;
      const pattern = /permission requested:\s*([^\s;(]+)\s*\(([^)]+)\)/gi;
      let match;
      while ((match = pattern.exec(line)) !== null) {
        const action = clean(match[1]) || 'permission';
        const permissionPattern = clean(match[2]) || null;
        emitPermission(action, permissionPattern);
      }
    };

    const flushStderrBuffer = () => {
      if (stderrFlushed) return;
      stderrFlushed = true;
      if (stderrBuffer) {
        const line = stderrBuffer;
        stderrBuffer = '';
        try {
          processStderrLine(line);
        } catch (error) {
          options.onError?.(error);
        }
      }
    };

    child.stderr.on('data', (chunk) => {
      stderrTail = `${stderrTail}${chunk}`.slice(-STDERR_TAIL);
      options.onStderr?.(stderrTail);
      // Headless ask rules surface only here: `! permission requested:
      // <action> (<pattern>); auto-rejecting`. Emit a synthetic permission
      // parsed event so the TUI shows an approve path instead of an opaque
      // `Tool execution interrupted` / `Step interrupted` failure. Keep
      // stderrTail capture unchanged (tail is still shown by finishTask).
      // `deny` rules never emit `permission requested` — they emit
      // `Permission denied: shell` on JSONL (handled above) — so this path
      // is only for ask/auto-reject visibility, not for bypassing deny.
      // Parse complete lines only: a permission line split across stderr
      // chunks (e.g. `! perm` + `ission requested:...`) would otherwise be
      // dropped by per-chunk matching. The trailing partial line is buffered
      // until its newline arrives (or the stream ends, see flush below).
      try {
        stderrBuffer += String(chunk ?? '');
        const lines = stderrBuffer.split('\n');
        stderrBuffer = lines.pop() ?? '';
        for (const line of lines) processStderrLine(line);
        if (stderrBuffer.length > 8192) stderrBuffer = stderrBuffer.slice(-8192);
      } catch (error) {
        options.onError?.(error);
      }
    });
    child.stderr.once('end', flushStderrBuffer);
    child.once('close', flushStderrBuffer);
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
    model: options.model,
    agentModels: {
      ...(allAgents ? Object.fromEntries(MODEL_AGENT_KEYS.map((agent) => [agent, options.model])) : {}),
      ...options.agentModels,
      ...(options.fallbackAttempt && hasAgentModels(options) ? { [options.agent ?? 'orchestrator']: options.model } : {}),
    },
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

/**
 * True for provider-quota / transient failures that justify trying another model.
 * Note: free models share one account quota — retrying another free model will
 * 429 until reset, but still tries (bounded). `no-route` (unsupported package/
 * variant) retries a different model too.
 */
export function isTransientProviderError(text) {
  return /provider\.quota|free usage limit|rate limit|429|no-route|unsupported package|variant unavailable|timeout|timed out|econnreset|etimedout|quota|limit (?:reached|exceeded|exhausted)|overloaded|capacity|too many|unavailable|exhausted|depleted|try again|try later|resource exhausted|model (?:is )?(?:currently )?(?:unavailable|overloaded)/i.test(String(text ?? ''));
}

/**
 * Launch `opencode run`, retrying quota/no-route failures with the next model
 * in `fallbackModels` (bounded, backoff). Returns { handle, done } like launchRun
 * but `done` resolves only after the final attempt. Events carry the model in meta.
 * Falls back only on transient errors; other failures resolve immediately.
 */
export async function launchRunWithFallback(options = {}) {
  options = { ...options, model: options.agentModels?.[options.agent ?? 'orchestrator'] ?? options.model };
  options = { ...options, coarena: usesCoarena(options) };
  let models = Array.isArray(options.fallbackModels) ? options.fallbackModels : [options.model].filter(Boolean);
  if (options.autoFallback && options.coarena) {
    const selected = options.model?.split('/')[1]?.split('#')[0];
    const available = coarenaModels({ ...process.env, ...options.env });
    const ordered = [...available.filter((model) => model.split('/')[1] === selected), ...available.filter((model) => model.split('/')[1] !== selected)];
    models = [...ordered, ...models];
  }
  const pool = [options.model ?? null, ...models.filter(Boolean)];
  const unique = [];
  for (const m of pool) {
    if (!unique.includes(m)) unique.push(m);
  }
  const maxAttempts = Math.max(1, unique.length);
  const backoff = (n) => new Promise((r) => setTimeout(r, Math.min(2000, 250 * 2 ** n)));
  let sessionID = options.sessionID;
  let cancelled = false;
  let lastHandle = null;
  let lastResult = null;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const model = unique[attempt];
    const handle = launchRun({ ...options, model, sessionID, fallbackAttempt: attempt > 0, onExit: undefined });
    const kill = handle.kill;
    handle.kill = (signal) => { cancelled = true; return kill(signal); };
    lastHandle = handle;
    try { options.onHandle?.(handle); } catch {}
    let streamedError = '';
    try {
      handle.onEvent((parsed) => {
        if (parsed?.error && !parsed.tool && !parsed.permission) streamedError = `${streamedError} ${parsed.error}`;
      });
    } catch {}
    const result = await handle.done;
    sessionID = handle.sessionID() ?? sessionID;
    lastResult = result;
    const failed = result?.error || streamedError || result?.code !== 0;
    if (!failed) return { handle, result, model: model ?? '(default)', exhausted: false };
    // Some OpenCode versions emit an error event but exit with status zero.
    if (streamedError && result.code === 0) result.code = 1;
    const attemptError = [streamedError, result?.error?.message, result?.stderr].filter(Boolean).join(' ').trim();
    if (attempt >= maxAttempts - 1 || cancelled || result?.signal || !isTransientProviderError(attemptError)) {
      return { handle, result, model: model ?? '(default)', exhausted: true };
    }
    try { options.onRetry?.(unique[attempt + 1], attemptError); } catch {}
    await backoff(attempt);
    if (cancelled) return { handle, result, model: model ?? '(default)', exhausted: false };
  }
  return { handle: lastHandle, result: lastResult, model: unique[unique.length - 1] ?? '(default)', exhausted: true };
}
