import { config } from "./config";
import { findModel } from "./models";
import {
  createSession,
  deleteSession,
  sendMessage,
  streamEvents,
  textFromResult,
  usageFromResult,
  preflightEvents,
  type StreamEvent,
  type BufferedEvents,
} from "./ocapi";
import { renderOpenAIMessages, partsFor } from "./prompts";
import { isRateLimitError, withRetry } from "./retry";

/**
 * OpenAI-compatible `POST /v1/chat/completions`.
 *
 * Supports `stream: false` (single JSON) and `stream: true` (SSE chunks).
 * Streaming waits for the first upstream event before committing the HTTP
 * response, so rate limits still trigger the retry (same model, fresh
 * session). The stream then terminates cleanly (with `[DONE]`) when the
 * backend generation is done.
 */

interface ChatRequest {
  model?: string;
  messages?: any[];
  stream?: boolean;
}

export async function handleChatCompletion(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => null)) as ChatRequest | null;
  if (!body?.model || !Array.isArray(body.messages)) {
    return json({ error: { message: "Missing model or messages" } }, 400);
  }

  const model = findModel(body.model);
  if (!model) {
    return json({ error: { message: `Unknown model: ${body.model}` } }, 400);
  }

  const stream = body.stream === true;
  const prompt = renderOpenAIMessages(body.messages);
  const parts = partsFor(prompt);

  if (!stream) {
    try {
      const result = await withRetry((attempt) => runSync(model.backend, parts, attempt), "oai-sync");
      return json({
        id: `chatcmpl-${crypto.randomUUID()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: textFromResult(result) },
            finish_reason: result.info.finish === "length" ? "length" : "stop",
          },
        ],
        usage: usageFromResult(result),
      });
    } catch (e) {
      return openAIError(e);
    }
  }

  return streamChat(model.backend, parts, body.model);
}

async function runSync(backend: { providerID: string; modelID: string }, parts: { type: "text"; text: string }[], attempt: number) {
  // Fresh session per attempt — the original repo's session rotation.
  const session = await createSession("opencode-nolimit", backend);
  try {
    const result = await sendMessage(session.id, { model: backend, parts });
    // Free tier sometimes replies with an empty body when throttled.
    if (!textFromResult(result) && result.info.finish !== "stop") {
      throw new Error("Empty response from upstream");
    }
    return result;
  } finally {
    void deleteSession(session.id).catch(() => {});
  }
}

/** Stream a chat completion as OpenAI SSE, retrying the same model. */
async function streamChat(
  backend: { providerID: string; modelID: string },
  parts: { type: "text"; text: string }[],
  publicModelId: string,
): Promise<Response> {
  try {
    // Each attempt uses a fresh session (rotation), same model.
    return await withRetry((attempt) => streamOne(backend, parts, publicModelId, attempt), "oai-stream");
  } catch (e) {
    return openAIError(e);
  }
}

/** Map any upstream failure to a clean OpenAI-style error response. */
function openAIError(e: unknown): Response {
  const message = e instanceof Error ? e.message : String(e);
  if (isRateLimitError(e)) return rateLimitError(message);
  return json({ error: { message, type: "server_error" } }, 500);
}

async function streamOne(
  backend: { providerID: string; modelID: string },
  parts: { type: "text"; text: string }[],
  publicModelId: string,
  _attempt: number,
): Promise<Response> {
  const session = await createSession("opencode-nolimit", model.backend);
  const controller = new AbortController();
  const eventPromise = streamEvents(controller.signal, session.id);
  const done = sendMessage(session.id, { model: backend, parts }, controller.signal);
  const completionId = `chatcmpl-${crypto.randomUUID()}`;

  const cleanup = () => {
    controller.abort();
    void deleteSession(session.id).catch(() => {});
  };

  // Pre-flight: wait for the first upstream event (or a fast failure) before
  // committing the 200 response. Rate limits are detected here, so the retry
  // in `streamChat` actually gets a chance to run.
  let pre: Awaited<ReturnType<typeof preflightEvents>>;
  try {
    pre = await preflightEvents(eventPromise, done, config.firstEventTimeoutMs);
  } catch (e) {
    // `done` rejected during the race — always clean up the event stream.
    cleanup();
    throw e;
  }

  if (pre.kind === "error") {
    cleanup();
    throw pre.error;
  }

  if (pre.kind === "result") {
    cleanup();
    const text = textFromResult(pre.result);
    // Backend finished before emitting a single event — usually a throttled,
    // empty reply. Treat as rate limit so the chain moves on.
    if (!text && pre.result.info.finish !== "stop") {
      throw new Error("Empty response from upstream");
    }
    return singleShotSSE(completionId, publicModelId, text, pre.result.info.finish === "length");
  }

  return buildStream(pre.buffered, session.id, controller, done, cleanup, completionId, publicModelId);
}

/** OpenAI SSE that sends a single complete chunk + `[DONE]`. */
function singleShotSSE(completionId: string, publicModelId: string, text: string, truncated: boolean): Response {
  const now = Math.floor(Date.now() / 1000);
  const frames = [
    `data: ${JSON.stringify({ id: completionId, object: "chat.completion.chunk", created: now, model: publicModelId, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })}`,
    `data: ${JSON.stringify({ id: completionId, object: "chat.completion.chunk", created: now, model: publicModelId, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}`,
    `data: ${JSON.stringify({ id: completionId, object: "chat.completion.chunk", created: now, model: publicModelId, choices: [{ index: 0, delta: {}, finish_reason: truncated ? "length" : "stop" }] })}`,
    "data: [DONE]",
  ];
  return sseResponse(frames.join("\n\n") + "\n\n");
}

function buildStream(
  buffered: BufferedEvents,
  sessionID: string,
  controller: AbortController,
  done: Promise<any>,
  cleanup: () => void,
  completionId: string,
  publicModelId: string,
): Response {
  const now = Math.floor(Date.now() / 1000);

  const stream = new ReadableStream({
    async start(c) {
      const encoder = new TextEncoder();
      const send = (data: object | string) => {
        try {
          c.enqueue(encoder.encode(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`));
        } catch {
          // client already gone — ignore
        }
      };

      send({
        id: completionId,
        object: "chat.completion.chunk",
        created: now,
        model: publicModelId,
        choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
      });

      const assistantIDs = new Set<string>();
      const seenText = new Map<string, string>();
      const streamedParts = new Set<string>();
      const partTypes = new Map<string, string>();
      let finished = false;

      const processEvent = (evt: StreamEvent): boolean => {
        // The global event bus carries events for every session — only ours.
        if (evt.sessionID !== sessionID) return false;
        if (evt.info?.role === "assistant" && evt.info.id) assistantIDs.add(evt.info.id);
        if (evt.part?.id && evt.part.type) partTypes.set(evt.part.id, evt.part.type);

        // Token-level deltas (preferred — smooth streaming). Skip reasoning parts.
        if (evt.type === "message.part.delta" && evt.field === "text" && evt.delta && evt.partID) {
          const kind = partTypes.get(evt.partID);
          if (kind && kind !== "text") return false;
          streamedParts.add(evt.partID);
          send({
            id: completionId,
            object: "chat.completion.chunk",
            created: now,
            model: publicModelId,
            choices: [{ index: 0, delta: { content: evt.delta }, finish_reason: null }],
          });
          return false;
        }

        // Fallback: full-text snapshots → emit only the newly added slice.
        if (evt.part?.type === "text" && evt.part.messageID && assistantIDs.has(evt.part.messageID)) {
          const key = evt.part.id ?? evt.part.messageID;
          if (streamedParts.has(key)) return false;
          const text = evt.part.text ?? "";
          const prev = seenText.get(key) ?? "";
          if (text.length > prev.length) {
            seenText.set(key, text);
            send({
              id: completionId,
              object: "chat.completion.chunk",
              created: now,
              model: publicModelId,
              choices: [{ index: 0, delta: { content: text.slice(prev.length) }, finish_reason: null }],
            });
          }
          return false;
        }

        // Backend went idle → generation is done.
        if (evt.type === "session.idle" || evt.type === "idle") return true;
        return false;
      };

      const finish = (truncated: boolean) => {
        send({
          id: completionId,
          object: "chat.completion.chunk",
          created: now,
          model: publicModelId,
          choices: [{ index: 0, delta: {}, finish_reason: truncated ? "length" : "stop" }],
        });
        send("[DONE]");
      };

      try {
        if (buffered.first && processEvent(buffered.first)) finished = true;
        if (!finished) {
          for await (const evt of buffered.iterator) {
            if (processEvent(evt)) {
              finished = true;
              break;
            }
          }
        }

        const result = await done;
        finish(result.info.finish === "length");
      } finally {
        cleanup();
        if (!finished) {
          // Stream closed without an idle event — try to finish cleanly anyway.
          try {
            const result = await done;
            finish(result.info.finish === "length");
          } catch {
            // upstream failed after we started — nothing more to do
          }
        }
        try {
          c.close();
        } catch {
          // already closed/cancelled by the client
        }
      }
    },
    cancel() {
      cleanup();
    },
  });

  return sseResponse(stream);
}

function sseResponse(body: ReadableStream | string): Response {
  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

function rateLimitError(message: string): Response {
  return json({ error: { message: `${message} (free model rate limit)`, type: "rate_limit_error", code: "rate_limit_exceeded" } }, 429);
}

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
