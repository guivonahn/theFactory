import { config, VERSION } from "./config";
import { ensureBackend, backendStatus, stopBackend } from "./backend";
import { authenticate, allKeys, rotateKeys } from "./keys";
import { currentModels, listModels, modelsMeta, refreshModels, startModelRefresher } from "./models";
import { handleChatCompletion, json } from "./openai";
import { handleMessages } from "./anthropic";
import { dashboardHtml } from "./dashboard";

/**
 * opencode-nolimit
 * ---------------
 * Free OpenCode models (DeepSeek & friends) exposed as OpenAI/Anthropic APIs.
 *
 *  GET  /                    → friendly dashboard
 *  GET  /health              → liveness + backend status
 *  GET  /v1/models           → model list
 *  POST /v1/chat/completions → OpenAI format (sync + stream)
 *  POST /v1/messages         → Anthropic format (sync + stream)
 *  GET  /api/status          → dashboard metadata
 *  GET  /api/keys            → dashboard metadata
 */

// Bring the backend up before accepting traffic. Fail fast with a clear error
// if the opencode CLI is missing.
await ensureBackend().catch((e: unknown) => {
  console.error("[fatal] could not start backend:", e instanceof Error ? e.message : e);
  process.exit(1);
});

// Keep the free model list in sync with models.dev (background, non-blocking).
startModelRefresher();

const server = Bun.serve({
  port: config.port,
  hostname: config.host,

  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    // ── Public routes ────────────────────────────────────────────────
    if (path === "/" ) return new Response(dashboardHtml(), { headers: { "Content-Type": "text/html; charset=utf-8" } });
    if (path === "/health") {
      return json({ status: "ok", version: `v${VERSION}`, backend: backendStatus(), models: currentModels().length });
    }
    if (path === "/api/status") {
      return json({
        version: VERSION,
        port: config.port,
        backend: backendStatus(),
        models: currentModels().map((m) => ({ id: m.id, label: m.label, reliability: m.reliability })),
        modelsMeta: modelsMeta(),
      });
    }
    // ── Model / chat routes require a valid API key ──────────────────
    const user = authenticate(req);
    if (!user) {
      return json({ error: { message: "Invalid API key", type: "authentication_error" } }, 401);
    }
    // ── Key management (rotate requires a valid key) ─────────────────
    if (path === "/api/keys" && req.method === "GET") {
      return json({ keys: allKeys() });
    }
    if (path === "/api/keys/rotate" && req.method === "POST") {
      return json({ keys: rotateKeys() });
    }
    // ── Model management (requires a valid key) ─────────────────────
    if (path === "/api/models/refresh" && req.method === "POST") {
      const models = await refreshModels();
      return json({ models: models.map((m) => ({ id: m.id, label: m.label, reliability: m.reliability })), meta: modelsMeta() });
    }
    if (path === "/v1/models") return json({ object: "list", data: listModels() });
    if (path === "/v1/chat/completions" && req.method === "POST") return handleChatCompletion(req);
    if (path === "/v1/messages" && req.method === "POST") return handleMessages(req);

    return json({ error: { message: `Not found: ${req.method} ${path}` } }, 404);
  },
});

console.log("");
console.log(`  opencode-nolimit v${VERSION}`);
console.log(`  Dashboard    http://localhost:${server.port}`);
console.log(`  OpenAI       POST http://localhost:${server.port}/v1/chat/completions`);
console.log(`  Anthropic    POST http://localhost:${server.port}/v1/messages`);
console.log(`  Models       GET  http://localhost:${server.port}/v1/models`);
console.log("");
for (const [name, key] of Object.entries(allKeys())) {
  console.log(`  ${name.padEnd(13)} ${key}`);
}
console.log("");

process.on("SIGINT", () => {
  stopBackend();
  process.exit(0);
});
process.on("SIGTERM", () => {
  stopBackend();
  process.exit(0);
});
