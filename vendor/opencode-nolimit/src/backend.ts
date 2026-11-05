import { spawn, type Subprocess } from "bun";
import { existsSync } from "node:fs";
import { config } from "./config";

/**
 * Owns the `opencode serve` child process.
 *
 * The free OpenCode models only answer requests that come from the real
 * opencode binary (Cloudflare fingerprints its TLS stack), so instead of
 * talking to opencode.ai directly this proxy drives the local CLI server.
 * This module makes sure that server is always up.
 */

let proc: Subprocess | null = null;
let port = config.backendPort;
let ready = false;
let starting: Promise<string> | null = null;
let restartCount = 0;
let serverPassword = "";

function resolveBinary(): string {
  if (config.opencodeBin && existsSync(config.opencodeBin)) return config.opencodeBin;
  return "opencode";
}

/** Start `opencode serve` and wait until its HTTP endpoint responds. */
export async function ensureBackend(): Promise<string> {
  if (ready && port > 0) return baseUrl();
  // De-duplicate concurrent start attempts (e.g. request racing a restart).
  if (starting) return starting;
  starting = start().finally(() => {
    starting = null;
  });
  return starting;
}

async function start(): Promise<string> {
  const bin = resolveBinary();
  // Always go back to the configured port (usually 0 = auto) so a restart that
  // finds the old port busy can re-detect the new one from the log line.
  port = config.backendPort;
  const log: string[] = [];

  proc = spawn({
    cmd: [bin, "serve", "--port", String(port || 0), "--hostname", "127.0.0.1"],
    stdout: "pipe",
    stderr: "pipe",
  });

  const collect = async (stream: ReadableStream<Uint8Array> | null) => {
    if (!stream) return;
    for await (const chunk of stream) {
      const text = chunk instanceof Uint8Array ? new TextDecoder().decode(chunk) : String(chunk);
      log.push(text);
      const passwordMatch = text.match(/server password ([^\r\n]+)/);
      if (passwordMatch) serverPassword = passwordMatch[1].trim();
      // "opencode server listening on http://127.0.0.1:PORT"
      const m = text.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (m && !port) port = Number(m[1]);
    }
  };
  const stdout = proc.stdout instanceof ReadableStream ? proc.stdout : null;
  const stderr = proc.stderr instanceof ReadableStream ? proc.stderr : null;
  void collect(stdout);
  void collect(stderr);

  proc.exited.then((code) => {
    console.log(`[backend] opencode serve exited (code=${code})`);
    proc = null;
    ready = false;
    // Bring it back with exponential backoff so a broken binary doesn't spin.
    if (code !== 0) {
      const delay = Math.min(1000 * 2 ** restartCount, 30_000);
      restartCount += 1;
      console.log(`[backend] restarting in ${delay}ms (attempt ${restartCount})`);
      setTimeout(() => void ensureBackend().catch(() => {}), delay);
    } else {
      restartCount = 0;
    }
  });

  // Wait until the endpoint answers.
  const deadline = Date.now() + config.backendStartTimeoutMs;
  while (Date.now() < deadline) {
    if (port > 0) {
      try {
        const res = await fetch(`${baseUrl()}/api/config`, {
          headers: backendAuthHeaders(),
          signal: AbortSignal.timeout(1500),
        });
        if (res.ok) {
          ready = true;
          restartCount = 0;
          console.log(`[backend] opencode serve ready at ${baseUrl()}`);
          return baseUrl();
        }
      } catch {
        // not up yet
      }
    }
    await Bun.sleep(300);
  }

  const tail = log.join("").slice(-3000);
  throw new Error(
    `Failed to start opencode serve.\n${tail}\n\n` +
      `Is the opencode CLI installed? Install with: npm i -g opencode-ai`,
  );
}

export function baseUrl(): string {
  return `http://127.0.0.1:${port}`;
}

export function backendAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  if (serverPassword) headers.Authorization = `Basic ${btoa(`opencode:${serverPassword}`)}`;
  return headers;
}

export function backendStatus() {
  return { running: ready && port > 0, port, pid: proc?.pid ?? null };
}

export function stopBackend(): void {
  proc?.kill();
  proc = null;
  ready = false;
}
