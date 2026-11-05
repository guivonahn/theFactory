import { join } from "node:path";

/**
 * Central configuration for opencode-nolimit.
 * Every setting can be overridden with an environment variable.
 */
export const config = {
  /** Public HTTP port of this proxy. */
  port: Number(process.env.PROXY_PORT || 6446),
  /** Bind address. 0.0.0.0 lets other devices on the LAN reach the proxy. */
  host: process.env.PROXY_HOST || "0.0.0.0",

  /** Internal port for the managed `opencode serve` backend. */
  backendPort: Number(process.env.OPENCODE_PORT || 0),

  /** Path to the opencode binary. Auto-detected from PATH when unset. */
  opencodeBin: process.env.OPENCODE_BIN || "",

  /** Where API keys are stored (auto-generated on first run). */
  keysFile: process.env.KEYS_FILE || join(import.meta.dir, "..", "data", "keys.json"),

  /** Timeout (ms) for waiting on the backend to come up. */
  backendStartTimeoutMs: Number(process.env.BACKEND_START_TIMEOUT_MS || 20_000),

  /** How long to wait for the first upstream event before retrying. */
  firstEventTimeoutMs: Number(process.env.FIRST_EVENT_TIMEOUT_MS || 30_000),

  /** How often to re-sync the free model list from models.dev (ms). */
  modelsRefreshMs: Number(process.env.MODELS_REFRESH_MS || 30 * 60 * 1000),

  /** Max time a single `opencode models` sync may take before it is killed. */
  modelsRefreshTimeoutMs: Number(process.env.MODELS_REFRESH_TIMEOUT_MS || 60_000),
} as const;

export const VERSION = "1.0.0";
