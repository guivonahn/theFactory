/**
 * Task launcher: spawn `opencode run --format json` and map its JSONL stream
 * into tolerant, app-level events. No npm dependencies.
 */

import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { resolveAgent } from './agents.js';
import { imagesFromPart } from './media.js';
import { automaticFallbackModels, coarenaModels, coarenaRunEnv, isCoarenaModel, usesCoarena } from './coarena.js';
import { agentModelsRunEnv, hasAgentModels, MODEL_AGENT_KEYS } from './agentModels.js';
import { toolLogEntry } from './logFormat.js';
import { agentPromptsRunEnv } from './agentPrompts.js';
import { providerFailure, recoveryEvent, unfinishedResponse } from './recovery.js';
import { createNativeSessionMonitor } from './nativeSessions.js';

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
    if (tool === 'todowrite' && Array.isArray(input.todos)) {
      result.tasks = input.todos.filter((todo) => todo && typeof todo === 'object' && typeof todo.content === 'string' && ['pending', 'in_progress', 'completed', 'cancelled'].includes(todo.status));
    }
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
    result.errorDetails = data.error ?? { message: result.error };
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
  if (usesCoarena(options) || hasAgentModels(options) || options.nativeRecovery) args.push('--standalone');
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
  env = agentPromptsRunEnv(env, { registry: options.registry, skillText: options.skillText ?? options.task, reportOnly: options.reportOnly });
  const child = spawn(command, args, {
    cwd: options.dir || process.cwd(),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: Boolean(options.nativeRecovery && process.platform !== 'win32'),
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
    agent: options.agent ?? 'orchestrator',
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
    interrupt(signal = 'SIGTERM') {
      if (options.nativeRecovery && process.platform !== 'win32' && child.pid) {
        try { process.kill(-child.pid, signal); return true; } catch {}
      }
      if (child.exitCode !== null || child.signalCode) return false;
      try {
        return child.kill(signal);
      } catch {
        return false;
      }
    },
    kill(signal = 'SIGTERM') { return handle.interrupt(signal); },
    async settleGroup() {
      if (!options.nativeRecovery || process.platform === 'win32' || !child.pid) return;
      const deadline = Date.now() + 2500;
      while (Date.now() < deadline) {
        try { process.kill(-child.pid, 0); } catch { return; }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
      await new Promise((resolve) => setTimeout(resolve, 25));
    },
  };
  return handle;
}

/** Backward-compatible predicate for retryable quota, network and model errors. */
export function isTransientProviderError(text) {
  const failure = providerFailure(text);
  return failure.switchModel && failure.kind !== 'authentication';
}

/**
 * Try every configured route, then retry temporary failures in bounded rounds.
 * Provider availability ends in a blocker; process/configuration faults are errors.
 * Never create a fresh session to replay work after a provider interruption.
 */
export async function launchRunWithFallback(options = {}) {
  options = { ...options, model: options.agentModels?.[options.agent ?? 'orchestrator'] ?? options.model };
  options = { ...options, coarena: usesCoarena(options) };
  let models = Array.isArray(options.fallbackModels) ? options.fallbackModels : [];
  if (options.autoFallback && options.coarena) {
    const available = coarenaModels({ ...process.env, ...options.env });
    models = automaticFallbackModels(options.model, available, models);
  }
  const pool = [...new Set([options.model ?? null, ...models.filter(Boolean)])];
  const retryRounds = Math.max(0, Math.min(3, options.retryRounds ?? 2));
  const history = [];
  let sessionID = options.sessionID;
  let cancelled = options.signal?.aborted ?? false;
  let activeHandle, wakeBackoff;
  const abort = () => { cancelled = true; activeHandle?.kill('SIGTERM'); wakeBackoff?.(); };
  options.signal?.addEventListener('abort', abort, { once: true });
  const wait = (attempt) => new Promise((resolve) => {
    const timer = setTimeout(done, Math.max(0, Math.min(5000, (options.retryDelayMs ?? 250) * 2 ** Math.min(attempt, 5))));
    function done() { clearTimeout(timer); wakeBackoff = null; resolve(); }
    wakeBackoff = done;
    if (cancelled) done();
  });
  let lastHandle = null, lastResult = { code: 1, signal: 'SIGTERM', cancelled: true }, lastModel = options.model;
  let queue = pool.map((model) => ({ model, round: 0 }));
  try {
    while (queue.length && !cancelled) {
      const { model, round } = queue.shift();
      const unavailable = options.recoveryState?.get(model);
      if (unavailable) {
        history.push({ ...unavailable, skipped: true });
        lastModel = model;
        lastResult = { code: 1, blocked: true, failureKind: unavailable.kind, reason: unavailable.reason, attempts: [...history] };
        continue;
      }
      let streamedError = '', details = null, hasText = false, permissionBlock = '';
      let handle, idleTimer, errorTimer, escalation, interrupted = false;
      let nativeTimer, nativeFailures = [];
      const nativeMonitor = options.nativeRecovery && !options.reportOnly
        ? createNativeSessionMonitor({ path: options.nativeDatabase ?? options.env?.OPENCODE_DB, since: Date.now() }) : null;
      const checkChildren = () => {
        if (!handle || nativeFailures.length || cancelled) return;
        const snapshot = nativeMonitor?.scan(handle.sessionID() ?? sessionID);
        if (!snapshot?.failures.length || snapshot.active.length) return;
        nativeFailures = snapshot.failures;
        // Stop the private parent and its tools before resuming any child.
        interrupted = true;
        handle.interrupt('SIGTERM');
        escalation = setTimeout(() => handle.interrupt('SIGKILL'), 2500);
        escalation.unref?.();
      };
      const idleMs = options.idleTimeoutMs ?? Number(process.env.FACTORY_PROVIDER_IDLE_TIMEOUT_MS || 180000);
      const interrupt = (reason) => {
        interrupted = true;
        streamedError ||= reason;
        handle?.interrupt('SIGTERM');
        escalation = setTimeout(() => handle?.interrupt('SIGKILL'), 2500);
        escalation.unref?.();
      };
      const resetIdle = (parsed) => {
        clearTimeout(idleTimer);
        // Tool commands can legitimately run longer than an API response.
        if (parsed?.tool && ['running', 'pending'].includes(parsed.logEntry?.status)) return;
        if (idleMs > 0) { idleTimer = setTimeout(() => interrupt('Provider response timed out'), idleMs); idleTimer.unref?.(); }
      };
      try {
        handle = launchRun({
          ...options, model, sessionID, fallbackAttempt: history.length > 0, onExit: undefined,
          task: history.length && sessionID
            ? `Resume the interrupted task in this session. Inspect preserved progress, continue the remaining work, and do not repeat completed side effects. Original task:\n${options.task ?? ''}`
            : options.task,
          onEvent: (parsed) => {
            resetIdle(parsed);
            if (parsed.permission) permissionBlock = `Permission required: ${parsed.permission.action}`;
            if (parsed.tool && parsed.error && providerFailure(parsed.error).kind === 'permission') permissionBlock = parsed.error;
            if (parsed.text?.trim()) hasText = true;
            if (parsed.error && !parsed.tool && !parsed.permission) {
              streamedError = `${streamedError} ${parsed.error}`.slice(-8000);
              details = parsed.errorDetails;
              if (!errorTimer) {
                errorTimer = setTimeout(() => interrupt(streamedError), options.errorGraceMs ?? 1000);
                errorTimer.unref?.();
              }
            }
            options.onEvent?.(recoveryEvent(parsed));
          },
        });
      } catch (error) {
        lastResult = { code: 1, error, failureKind: 'system', blocked: false, attempts: history };
        return { handle: lastHandle, result: lastResult, model: model ?? '(default)', exhausted: true };
      }
      activeHandle = lastHandle = handle; lastModel = model;
      if (nativeMonitor) {
        nativeTimer = setInterval(checkChildren, options.nativePollMs ?? 100);
        nativeTimer.unref?.();
      }
      resetIdle();
      const kill = handle.kill;
      handle.kill = (signal) => { cancelled = true; wakeBackoff?.(); return kill(signal); };
      try { options.onHandle?.(handle); } catch {}
      const result = await handle.done;
      // Also catch child failure immediately before the parent exits.
      checkChildren();
      clearInterval(nativeTimer); nativeMonitor?.close();
      clearTimeout(idleTimer); clearTimeout(errorTimer); clearTimeout(escalation);
      if (nativeFailures.length || cancelled || interrupted) await handle.settleGroup();
      sessionID = handle.sessionID() ?? sessionID;
      lastResult = result;
      if (cancelled || options.signal?.aborted) break;
      if (nativeFailures.length) return { handle, model: model ?? '(default)', exhausted: false,
        result: { ...result, code: 1, blocked: true, failureKind: 'native-children', nativeFailures, attempts: history,
          reason: `${nativeFailures.length} native subagent session(s) require recovery` } };
      const empty = result.code === 0 && !streamedError && !hasText;
      // stderr-only provider failures can also arrive with exit status zero.
      const stderrFailure = result.stderr && providerFailure(result.stderr);
      const failed = result.error || streamedError || result.code !== 0 || empty || !hasText && stderrFailure?.switchModel;
      if (!failed) return { handle, result: { ...result, attempts: history }, model: model ?? '(default)', exhausted: false };
      const reason = [streamedError, result.error?.message, result.stderr, !hasText && permissionBlock, empty && !permissionBlock && 'Empty response from provider'].filter(Boolean).join(' ').trim();
      const failure = result.error || result.signal && !interrupted ? { kind: 'system', retry: false, switchModel: false }
        : !hasText && permissionBlock ? { kind: 'permission', retry: false, switchModel: false }
        : providerFailure(details ?? reason, { provider: Boolean(streamedError) });
      history.push({ model: model ?? '(default)', round, kind: failure.kind, reason: reason.slice(-2000) });
      if (['quota', 'authentication'].includes(failure.kind)) options.recoveryState?.set(model, history.at(-1));
      // A long-lived quota failure must not consume later transient retry rounds.
      if (!failure.retry) queue = queue.filter((attempt) => attempt.model !== model);
      if (failure.retry && round < retryRounds) queue.push({ model, round: round + 1 });
      if (!failure.switchModel) queue = [];
      result.code = result.code || 1;
      result.failureKind = failure.kind;
      result.blocked = failure.kind !== 'system';
      result.reason = reason || `opencode exited with code ${result.code}`;
      result.attempts = [...history];
      if (!queue.length) return { handle, result, model: model ?? '(default)', exhausted: true };
      try { options.onRetry?.(queue[0].model, reason, { kind: failure.kind, attempt: history.length, round: queue[0].round }); } catch {}
      await wait(history.length - 1);
    }
    return { handle: lastHandle, result: cancelled
      ? { ...lastResult, code: lastResult.code || 1, signal: lastResult.signal || 'SIGTERM', cancelled: true, attempts: history }
      : { ...lastResult, attempts: history }, model: lastModel ?? '(default)', exhausted: !cancelled };
  } finally { options.signal?.removeEventListener('abort', abort); wakeBackoff?.(); }
}

/** Continue unfinished work in the same session, with its current files intact. */
export async function launchTaskWithRecovery(options = {}) {
  options = { ...options, recoveryState: options.recoveryState ?? new Map() };
  const limit = Math.max(0, Math.min(3, options.continuationAttempts ?? 2));
  let sessionID = options.sessionID, model = options.model, task = options.task;
  let launched;
  const reports = [], attempts = [];
  let cancelled = false, continuation = 0, nativeRounds = 0;
  const nativeRecoveries = [];
  const trackHandle = (handle) => {
    const kill = handle.kill;
    handle.kill = (signal) => { cancelled = true; return kill(signal); };
    options.onHandle?.(handle);
  };
  while (true) {
    if (cancelled || options.signal?.aborted || options.isCancelled?.()) return { ...launched, result: { ...launched?.result, code: 1, cancelled: true, signal: 'SIGTERM', nativeRecoveries: [...nativeRecoveries], attempts: [...attempts] } };
    const chunks = new Map(); let sequence = 0;
    launched = await launchRunWithFallback({
      ...options, model, task, sessionID,
      onHandle: trackHandle,
      onEvent: (parsed) => {
        if (parsed.text) chunks.set(parsed.logEntry?.id || `part-${sequence++}`, parsed.text);
        options.onEvent?.(parsed);
      },
      onRetry: (...args) => {
        const partial = [...chunks.values()].join('\n\n');
        if (partial.trim()) reports.push(partial.slice(-16000));
        chunks.clear(); sequence = 0; options.onRetry?.(...args);
      },
    });
    attempts.push(...(launched.result.attempts ?? []));
    launched.result.attempts = [...attempts];
    launched.result.partialReports = [...reports.slice(-4)];
    launched.result.nativeRecoveries = [...nativeRecoveries];
    if (launched.result.nativeFailures?.length && !cancelled && !options.signal?.aborted) {
      if (nativeRounds >= 2 || (options.nativeDepth ?? 0) >= 3 || process.platform === 'win32') {
        launched.result.reason = 'Native subagent recovery could not establish further safe progress; existing work is retained.';
        return launched;
      }
      nativeRounds++;
      const rootModel = launched.model === '(default)' ? options.model : launched.model;
      const rootSession = launched.handle?.sessionID() ?? sessionID;
      const handoffs = [];
      for (const child of launched.result.nativeFailures) {
        if (cancelled || options.signal?.aborted || options.isCancelled?.()) break;
        let childModel;
        const emitChild = (parsed) => {
          const agent = parsed.isSubagent ? parsed.agent : child.agent;
          const sid = parsed.isSubagent ? parsed.sessionID : child.id;
          options.onEvent?.({ ...parsed, agent, isSubagent: true,
            sessionID: sid, logEntry: parsed.logEntry ? { ...parsed.logEntry, sessionID: sid, model: parsed.logEntry.model ?? (!parsed.isSubagent ? childModel : undefined) } : undefined,
            events: (parsed.events ?? []).map((event) => ({ ...event, from: agent, sessionID: sid, state: event.state ?? 'working' })) });
        };
        const status = (text, state = 'working') => emitChild({ text: null,
          logEntry: { kind: 'status', status: state === 'working' ? 'recovering' : state === 'done' ? 'completed' : 'blocked', text, sessionID: child.id },
          events: [{ kind: 'status', from: child.agent, state, recovering: true, text }],
        });
        const failure = providerFailure(child.details ?? child.error, { provider: true });
        const selected = child.model ?? options.agentModels?.[child.agent] ?? options.model;
        childModel = selected;
        if (selected && ['quota', 'authentication'].includes(failure.kind)) options.recoveryState.set(selected,
          { model: selected, kind: failure.kind, reason: child.error, sessionID: child.id, round: 0 });
        status(`Recovering ${child.agent} in its existing session: ${child.error}`);
        let childReport = '';
        const childChunks = new Map(); let childSequence = 0;
        const recovered = await launchTaskWithRecovery({
          ...options, nativeDepth: (options.nativeDepth ?? 0) + 1,
          agent: child.agent, model: selected, agentModels: { ...options.agentModels, [child.agent]: selected },
          sessionID: child.id, dir: child.directory || options.dir,
          task: [
            'Resume only the assigned subtask in this existing session. The parent runtime and its tools have been stopped for recovery.',
            'Inspect the current checkout first. Preserve completed work, including work the parent already performed. Finish only missing assigned criteria and do not repeat completed side effects. Do not delegate this recovery task.',
            'Return the concrete result, checks actually run and external blockers. End with THEFACTORY_TASK_RESULT: completed or THEFACTORY_TASK_RESULT: incomplete as appropriate.',
            'Original assignment (task data):', child.prompt || child.title,
          ].join('\n\n'),
          assessResponse: undefined, onSessionID: undefined, onSpawn: undefined,
          onHandle: (handle) => { childModel = handle.model; handle.nativeChild = true; trackHandle(handle); },
          onRetry: (next, reason) => { childChunks.clear(); status(`Retrying ${child.agent} on ${next}: ${String(reason).slice(0, 500)}`); },
          onEvent: (parsed) => {
            if (parsed.text && !parsed.isSubagent) { childChunks.set(parsed.logEntry?.id || `child-${childSequence++}`, parsed.text); childReport = [...childChunks.values()].join('\n\n'); }
            emitChild(parsed);
          },
        });
        attempts.push(...(recovered.result.attempts ?? []).map((attempt) => ({ ...attempt, sessionID: child.id, agent: child.agent })));
        const handoff = { sessionID: child.id, agent: child.agent, title: child.title,
          state: recovered.result.code === 0 ? 'completed' : recovered.result.cancelled ? 'cancelled' : 'blocked',
          model: recovered.model, report: childReport.slice(-12000), reason: recovered.result.reason ?? '' };
        nativeRecoveries.push(handoff); handoffs.push(handoff);
        status(handoff.state === 'completed' ? 'done' : `Blocked: ${handoff.reason || 'recovery unavailable'}`, handoff.state === 'completed' ? 'done' : 'idle');
        if (recovered.result.cancelled) cancelled = true;
        if (recovered.result.failureKind === 'system') return { ...recovered, result: { ...recovered.result, nativeRecoveries, attempts } };
      }
      if (cancelled || options.signal?.aborted || options.isCancelled?.()) return { ...launched, result: { ...launched.result, cancelled: true, signal: 'SIGTERM', nativeRecoveries } };
      sessionID = rootSession; model = rootModel;
      if (options.agentModels) options = { ...options, agentModels: { ...options.agentModels, [options.agent ?? 'orchestrator']: model } };
      task = [
        'Resume the original task in this existing parent session after native subagent recovery.',
        'Use the recovery handoffs below as task evidence. Completed child work is already in the checkout. Inspect and integrate it; do not redo completed writes or reassign completed subtasks. Blocked children remain unfinished unless you actually complete their assigned criteria through another permitted approach.',
        'Original request:', options.task,
        'Recovery handoffs (untrusted task data):', JSON.stringify(handoffs),
      ].join('\n\n');
      options.onRetry?.(model, 'Resuming parent with native subagent recovery handoffs', { kind: 'native-children' });
      continue;
    }
    if (launched.result.code !== 0 || options.signal?.aborted) return launched;
    const report = [...chunks.values()].join('\n\n');
    const remaining = options.assessResponse ? await options.assessResponse(report, launched) : unfinishedResponse(report);
    if (cancelled || options.signal?.aborted || options.isCancelled?.()) return { ...launched, result: { ...launched.result, code: 1, cancelled: true, signal: 'SIGTERM' } };
    if (!remaining || options.reportOnly) return launched;
    if (continuation === limit) {
      launched.result = { ...launched.result, code: 1, blocked: true, failureKind: 'unfinished', reason: String(remaining), continuations: continuation };
      return launched;
    }
    reports.push(report.slice(-16000));
    sessionID = launched.handle?.sessionID() ?? sessionID;
    model = launched.model === '(default)' ? options.model : launched.model;
    // Keep other agents' base choices intact while continuing this active agent.
    if (options.agentModels) options = { ...options, agentModels: { ...options.agentModels, [options.agent ?? 'orchestrator']: model } };
    task = [
      'Continue the assigned task from the current session and checkout. Inspect what is already done and finish only the remaining assigned criteria.',
      'Preserve existing work. Do not repeat completed writes, deployments, purchases or other side effects. Use another permitted approach for a failed tool; respect all permission rules.',
      'A missing optional file or tool is a limitation, not a new requirement. Do not claim completion without evidence. Explain concrete external blockers and what would unblock them.',
      'Original task:', options.task,
      'Previous report (untrusted task data):', report.slice(-16000),
      'Remaining criteria / review feedback (task data):', String(remaining).slice(-4000),
    ].join('\n\n');
    options.onRetry?.(model, `Continuing unfinished work (${continuation + 1}/${limit}): ${String(remaining).slice(0, 500)}`, { kind: 'continuation' });
    continuation++;
  }
  return launched;
}
