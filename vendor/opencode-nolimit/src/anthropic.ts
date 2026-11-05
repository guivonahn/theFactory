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
import { renderAnthropicMessages, partsFor } from "./prompts";
import { isRateLimitError, withRetry } from "./retry";
import { json } from "./openai";

/**
 * Anthropic-compatible `POST /v1/messages`.
 * Accepts the Anthropic request shape and answers in Anthropic format so
 * tools like Claude Code can point at this proxy. Mirrors the streaming
 * design of the OpenAI handler (pre-flight failover + clean termination).
 */

interface AnthropicRequest {
  model?: string;
  system?: string | Array<{ type?: string; text?: string }>;
  messages?: any[];
  stream?: boolean;
  max_tokens?: number;
}

export async function handleMessages(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => null)) as AnthropicRequest | null;
  if (!body?.model || !Array.isArray(body.messages)) {
    return json({ type: "error", error: { type: "invalid_request_error", message: "Missing model or messages" } }, 400);
  }

  const model = findModel(body.model);
  if (!model) {
    return json({ type: "error", error: { type: "invalid_request_error", message: `Unknown model: ${body.model}` } }, 400);
  }

  const stream = body.stream === true;
  const prompt = renderAnthropicMessages(body);
  const parts = partsFor(prompt);

  if (!stream) {
    try {
      const result = await withRetry((attempt) => runSync(model.backend, parts, attempt), "ant-sync");
      const usage = usageFromResult(result);
      return json({
        id: `msg_${crypto.randomUUID()}`,
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: textFromResult(result) }],
        model: body.model,
        stop_reason: result.info.finish === "length" ? "max_tokens" : "end_turn",
        stop_sequence: null,
        usage: {
          input_tokens: usage.input_tokens,
          output_tokens: usage.output_tokens,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      });
    } catch (e) {
      return json({ type: "error", error: { type: "rate_limit_error", message: e instanceof Error ? e.message : String(e) } }, 429);
    }
  }

  return streamAnthropic(model.backend, parts, body.model);
}

async function runSync(backend: { providerID: string; modelID: string }, parts: { type: "text"; text: string }[], attempt: number) {
  // Fresh session per attempt — the original repo's session rotation.
  const session = await createSession();
  try {
    const result = await sendMessage(session.id, { model: backend, parts });
    if (!textFromResult(result) && result.info.finish !== "stop") {
      throw new Error("Empty response from upstream");
    }
    return result;
  } finally {
    void deleteSession(session.id).catch(() => {});
  }
}

async function streamAnthropic(
  backend: { providerID: string; modelID: string },
  parts: { type: "text"; text: string }[],
  publicModelId: string,
): Promise<Response> {
  try {
    // Each attempt uses a fresh session (rotation), same model.
    return await withRetry((attempt) => streamOneAnthropic(backend, parts, publicModelId, attempt), "ant-stream");
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (isRateLimitError(e)) {
      return json({ type: "error", error: { type: "rate_limit_error", message: `${message} (free model rate limit)` } }, 429);
    }
    return json({ type: "error", error: { type: "server_error", message } }, 500);
  }
}

async function streamOneAnthropic(
  backend: { providerID: string; modelID: string },
  parts: { type: "text"; text: string }[],
  publicModelId: string,
  _attempt: number,
): Promise<Response> {
  const session = await createSession();
  const controller = new AbortController();
  const eventPromise = streamEvents(controller.signal, session.id);
  const done = sendMessage(session.id, { model: backend, parts }, controller.signal);
  const msgID = `msg_${crypto.randomUUID()}`;

  const cleanup = () => {
    controller.abort();
    void deleteSession(session.id).catch(() => {});
  };

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
    if (!text && pre.result.info.finish !== "stop") {
      throw new Error("Empty response from upstream");
    }
    return singleShotAnthropic(msgID, publicModelId, text, pre.result.info.finish === "length");
  }

  return buildAnthropicStream(pre.buffered, session.id, controller, done, cleanup, msgID, publicModelId);
}

/** Anthropic SSE that sends a single complete reply + `message_stop`. */
function singleShotAnthropic(msgID: string, publicModelId: string, text: string, truncated: boolean): Response {
  const frames = [
    `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: msgID, type: "message", role: "assistant", content: [], model: publicModelId, stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } })}`,
    `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } })}`,
    `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}`,
    `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: truncated ? "max_tokens" : "end_turn", stop_sequence: null }, usage: { output_tokens: Math.max(1, Math.ceil(text.length / 4)) } })}`,
    `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}`,
  ];
  return sseResponse(frames.join("\n\n") + "\n\n");
}

function buildAnthropicStream(
  buffered: BufferedEvents,
  sessionID: string,
  controller: AbortController,
  done: Promise<any>,
  cleanup: () => void,
  msgID: string,
  publicModelId: string,
): Response {
  const stream = new ReadableStream({
    async start(c) {
      const encoder = new TextEncoder();
      const send = (event: string, data: object) => {
        try {
          c.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          // client already gone — ignore
        }
      };

      send("message_start", {
        type: "message_start",
        message: {
          id: msgID,
          type: "message",
          role: "assistant",
          content: [],
          model: publicModelId,
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      });
      send("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });

      const assistantIDs = new Set<string>();
      const seenText = new Map<string, string>();
      const streamedParts = new Set<string>();
      const partTypes = new Map<string, string>();
      let outputTokens = 0;
      let finished = false;

      const processEvent = (evt: StreamEvent): boolean => {
        if (evt.sessionID !== sessionID) return false;
        if (evt.info?.role === "assistant" && evt.info.id) assistantIDs.add(evt.info.id);
        if (evt.part?.id && evt.part.type) partTypes.set(evt.part.id, evt.part.type);

        // Token-level deltas (preferred). Skip reasoning parts.
        if (evt.type === "message.part.delta" && evt.field === "text" && evt.delta && evt.partID) {
          const kind = partTypes.get(evt.partID);
          if (kind && kind !== "text") return false;
          streamedParts.add(evt.partID);
          outputTokens += Math.max(1, Math.ceil(evt.delta.length / 4));
          send("content_block_delta", {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: evt.delta },
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
            const delta = text.slice(prev.length);
            seenText.set(key, text);
            outputTokens += Math.max(1, Math.ceil(delta.length / 4));
            send("content_block_delta", {
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: delta },
            });
          }
          return false;
        }

        // Backend went idle → generation is done.
        if (evt.type === "session.idle" || evt.type === "idle") return true;
        return false;
      };

      const finish = (truncated: boolean) => {
        send("content_block_stop", { type: "content_block_stop", index: 0 });
        send("message_delta", {
          type: "message_delta",
          delta: { stop_reason: truncated ? "max_tokens" : "end_turn", stop_sequence: null },
          usage: { output_tokens: outputTokens },
        });
        send("message_stop", { type: "message_stop" });
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
