import { backendAuthHeaders, baseUrl } from "./backend";
import type { BackendModel } from "./models";

function apiHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...backendAuthHeaders(),
    "x-opencode-directory": process.cwd(),
    ...extra,
  };
}

/**
 * Thin typed client for the `opencode serve` HTTP API.
 *
 * Only the endpoints this proxy needs are modelled here, which keeps the
 * surface small and easy to maintain.
 */

export interface SessionInfo {
  id: string;
  title?: string;
  model?: { providerID?: string; modelID?: string };
}

export interface MessagePart {
  type: string;
  text?: string;
  id?: string;
  messageID?: string;
}

export interface MessageResult {
  info: {
    id: string;
    role: string;
    modelID?: string;
    providerID?: string;
    finish?: string;
    tokens?: {
      input?: number;
      output?: number;
      reasoning?: number;
      cache?: { read?: number; write?: number };
    };
  };
  parts: MessagePart[];
}

export interface SendOptions {
  model: BackendModel;
  parts: { type: "text"; text: string }[];
  agent?: string;
}

function promptParts(parts: SendOptions["parts"]) {
  return parts.map((part) => ({
    type: part.type,
    text: part.text,
  }));
}

export async function createSession(
  title = "opencode-nolimit",
  model?: BackendModel,
): Promise<SessionInfo> {
  const res = await fetch(`${baseUrl()}/api/session`, {
    method: "POST",
    headers: apiHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({
      title,
      ...(model ? { model: { providerID: model.providerID, id: model.modelID } } : {}),
    }),
  });
  if (!res.ok) throw new Error(`createSession failed: HTTP ${res.status} ${await res.text()}`);
  const created = await res.json() as SessionInfo & { sessionID?: string; sessionId?: string; data?: SessionInfo };
  if (created.data?.id) return created.data;
  created.id ??= created.sessionID ?? created.sessionId;
  return created;
}

/** Best-effort cleanup of a session once we are done with it. */
export async function deleteSession(sessionID: string): Promise<void> {
  try {
    await fetch(`${baseUrl()}/api/session/${sessionID}`, { method: "DELETE", headers: apiHeaders() });
  } catch {
    // nothing to do — cleanup is best-effort
  }
}

/** Send a message and wait for the final (non-streamed) result. */
export async function sendMessage(sessionID: string, opts: SendOptions, signal?: AbortSignal): Promise<MessageResult> {
  const body = {
    text: promptParts(opts.parts).map((part) => part.text ?? "").join("\n"),
  };
  let res = await fetch(`${baseUrl()}/api/session/${sessionID}/message`, {
    method: "POST",
    headers: apiHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(body),
    signal,
  });
  if (res.status === 404) {
    res = await fetch(`${baseUrl()}/api/session/${sessionID}/prompt`, {
      method: "POST",
      headers: apiHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(body),
      signal,
    });
  }
  if (res.status === 404) {
    res = await fetch(`${baseUrl()}/api/session/${sessionID}/prompt_async/`, {
      method: "POST",
      headers: apiHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(body),
      signal,
    });
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`sendMessage failed: HTTP ${res.status} ${text.slice(0, 300)} url=${res.url}`);
  }
  if (res.status === 204) {
    return { info: { id: "", role: "assistant", finish: "stop" }, parts: [] };
  }
  const payload = await res.json() as { data?: unknown };
  if (payload && typeof payload === "object" && payload.data && "parts" in payload) {
    return payload.data as MessageResult;
  }

  // Current OpenCode prompt calls durably admit work instead of returning the
  // completed assistant message. Poll the session transcript until it finishes.
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    await Bun.sleep(250);
    const messages = await fetch(`${baseUrl()}/api/session/${sessionID}/message?limit=20`, {
      headers: apiHeaders(),
      signal,
    });
    if (!messages.ok) continue;
    const listed = await messages.json() as { data?: any[] };
    const rows = Array.isArray(listed) ? listed : listed.data ?? [];
    console.log(`[ocapi] transcript=${JSON.stringify(rows.slice(-2))}`);
    const assistant = [...rows].reverse().find((row) =>
      (row.info?.role === "assistant" || row.role === "assistant") &&
      (row.info?.finish === "stop" || row.info?.finish === "length" || row.finish === "stop" || row.finish === "length")
    );
    if (assistant) return {
      info: assistant.info ?? { id: assistant.id ?? "", role: "assistant", finish: assistant.finish ?? "stop" },
      parts: assistant.parts ?? [],
    };
  }
  throw new Error(`Timed out waiting for OpenCode response in session ${sessionID}`);
}

export interface StreamEvent {
  type: string;
  sessionID?: string;
  messageID?: string;
  partID?: string;
  part?: MessagePart;
  info?: { role?: string; id?: string };
  /** Present for `message.part.delta` events (token-level streaming). */
  delta?: string;
  field?: string;
}

/**
 * Open the global SSE event stream from the opencode backend.
 * Yields parsed events until the stream closes or `signal` aborts.
 *
 * When `sessionID` is given, only events for that session are yielded — the
 * bus carries events for every session at once, so callers must filter.
 */
export async function* streamEvents(signal: AbortSignal, sessionID?: string): AsyncGenerator<StreamEvent> {
  const res = await fetch(`${baseUrl()}/api/event`, { headers: apiHeaders(), signal });
  if (!res.ok || !res.body) {
    throw new Error(`event stream failed: HTTP ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE frames are separated by a blank line; tolerate CRLF too.
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        for (const line of frame.split("\n")) {
          const clean = line.replace(/\r$/, "");
          if (!clean.startsWith("data: ")) continue;
          const payload = clean.slice(6).trim();
          if (!payload) continue;
          try {
            const raw = JSON.parse(payload) as any;
            const evt = raw.payload ?? raw;
            const normalized = normalizeEvent(evt?.type === "sync" && evt?.syncEvent?.payload ? evt.syncEvent.payload : evt);
            if (sessionID && normalized.sessionID !== sessionID) continue;
            yield normalized;
          } catch {
            // ignore malformed frames
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Pull the first event off a stream *before* the caller commits its HTTP
 * response. This lets streaming retry work: if the upstream rate-limits us,
 * the error surfaces here — while we can still retry the same model with a
 * fresh session — instead of halfway through a 200 stream the client already
 * received.
 */
export interface BufferedEvents {
  iterator: AsyncIterableIterator<StreamEvent>;
  first: StreamEvent | null;
}

export type Preflight =
  | { kind: "buffered"; buffered: BufferedEvents }
  | { kind: "result"; result: MessageResult }
  | { kind: "error"; error: Error };

export async function preflightEvents(
  events: AsyncGenerator<StreamEvent>,
  done: Promise<MessageResult>,
  timeoutMs: number,
): Promise<Preflight> {
  const iterator = events[Symbol.asyncIterator]();

  // The first event is pulled exactly once and reused across the races below.
  const firstEvent = iterator.next();
  const doneSettled = done.then(
    (result): Preflight => ({ kind: "result", result }),
    (error): Preflight => ({ kind: "error", error: error instanceof Error ? error : new Error(String(error)) }),
  );

  const outcome = await Promise.race([
    firstEvent.then((r) => (r.done ? ({ kind: "ended" } as const) : ({ kind: "event", value: r.value } as const))),
    doneSettled,
    Bun.sleep(timeoutMs).then((): Preflight => ({ kind: "error", error: new Error("Timed out waiting for upstream to start generating") })),
  ]);

  // A healthy stream emits its first event before `done` can possibly settle
  // (generation takes seconds). If `done` still wins, give a short grace for
  // the event to land — this keeps the outcome deterministic when both settle
  // in the same tick — then fall back to the finished result / error.
  if (outcome.kind === "event") {
    return { kind: "buffered", buffered: { iterator, first: outcome.value } };
  }

  if (outcome.kind === "ended") {
    // Event stream closed without a single event — use the finished message.
    const settled = await Promise.race([doneSettled, Bun.sleep(timeoutMs).then(() => null)]);
    if (settled === null) {
      return { kind: "error", error: new Error("Upstream ended without any events or result") };
    }
    return settled;
  }

  if (outcome.kind === "error") {
    const grace = await Promise.race([firstEvent, Bun.sleep(250).then(() => null)]);
    if (grace && !grace.done) {
      return { kind: "buffered", buffered: { iterator, first: grace.value } };
    }
    return outcome;
  }

  // done resolved before any event — same grace check, then the result.
  const grace = await Promise.race([firstEvent, Bun.sleep(250).then(() => null)]);
  if (grace && !grace.done) {
    return { kind: "buffered", buffered: { iterator, first: grace.value } };
  }
  return outcome;
}

function normalizeEvent(evt: any): StreamEvent {
  const props = evt.properties ?? {};
  return {
    type: evt.type ?? "unknown",
    sessionID: props.sessionID,
    messageID: props.part?.messageID ?? props.messageID,
    partID: props.part?.id ?? props.partID,
    part: props.part,
    info: props.info,
    delta: props.delta,
    field: props.field,
  };
}

/** Extract the assistant's text from a finished message result. */
export function textFromResult(result: MessageResult): string {
  return result.parts
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text as string)
    .join("");
}

/** Token usage in a form the proxy can reuse. */
export function usageFromResult(result: MessageResult) {
  const t = result.info.tokens ?? {};
  return {
    input_tokens: t.input ?? 0,
    output_tokens: t.output ?? 0,
    reasoning_tokens: t.reasoning ?? 0,
    cache_read_input_tokens: t.cache?.read ?? 0,
    cache_creation_input_tokens: t.cache?.write ?? 0,
  };
}
