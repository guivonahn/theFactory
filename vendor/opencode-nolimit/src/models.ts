import { spawn } from "bun";
import { existsSync } from "node:fs";
import { config } from "./config";

/**
 * Dynamic model registry.
 *
 * The list of free models is *not* hardcoded — it is fetched from the opencode
 * CLI (`opencode models opencode --refresh --verbose`), which itself syncs from
 * models.dev. Models are filtered to free tier (cost input/output = 0).
 *
 * The registry starts from a static seed so the server works immediately, then
 * is refreshed in the background (see `startModelRefresher`). If a refresh
 * fails, the previous list is kept.
 */

export interface BackendModel {
  providerID: string;
  modelID: string;
}

export interface PublicModel {
  /** Id clients send to this proxy. */
  id: string;
  /** Human friendly label shown in the dashboard. */
  label: string;
  /** The single backend that serves this model. */
  backend: BackendModel;
  /** Reliability hint for the dashboard. */
  reliability: "solid" | "rate-limited" | "intermittent";
  /** Free tier costs (always 0 — these are the free models). */
  cost?: { input: number; output: number };
}

// Static seed — used until the first successful refresh, and as the fallback
// if the opencode CLI is ever unavailable.
const SEED_MODELS: PublicModel[] = [
  {
    id: "deepseek-v4-flash-free",
    label: "DeepSeek V4 Flash (Free)",
    reliability: "rate-limited",
    backend: { providerID: "opencode", modelID: "deepseek-v4-flash-free" },
  },
  {
    id: "big-pickle",
    label: "Big Pickle (DeepSeek alias)",
    reliability: "rate-limited",
    backend: { providerID: "opencode", modelID: "big-pickle" },
  },
  {
    id: "hy3-free",
    label: "Hy3 (Free)",
    reliability: "solid",
    backend: { providerID: "opencode", modelID: "hy3-free" },
  },
  {
    id: "laguna-s-2.1-free",
    label: "Laguna S 2.1 (Free)",
    reliability: "solid",
    backend: { providerID: "opencode", modelID: "laguna-s-2.1-free" },
  },
  {
    id: "nemotron-3.5-lightning-free",
    label: "Nemotron 3.5 Lightning (Free)",
    reliability: "solid",
    backend: { providerID: "opencode", modelID: "nemotron-3.5-lightning-free" },
  },
  {
    id: "mimo-v2.5-free",
    label: "MiniMax M2.5 (Free)",
    reliability: "rate-limited",
    backend: { providerID: "opencode", modelID: "mimo-v2.5-free" },
  },
  {
    id: "nemotron-3-ultra-free",
    label: "Nemotron 3 Ultra (Free)",
    reliability: "intermittent",
    backend: { providerID: "opencode", modelID: "nemotron-3-ultra-free" },
  },
  {
    id: "ling-3.0-tiny-free",
    label: "Ling 3.0 Tiny (Free)",
    reliability: "intermittent",
    backend: { providerID: "opencode", modelID: "ling-3.0-tiny-free" },
  },
];

/** Known reliability hints keyed by model id (kept across refreshes). */
const RELIABILITY_HINTS: Record<string, PublicModel["reliability"]> = Object.fromEntries(
  SEED_MODELS.map((m) => [m.id, m.reliability]),
);

let cache: PublicModel[] = [...SEED_MODELS];
let lastRefreshAt = 0;
let refreshing: Promise<void> | null = null;

function resolveBinary(): string {
  if (config.opencodeBin && existsSync(config.opencodeBin)) return config.opencodeBin;
  return "opencode";
}

interface RawModel {
  id: string;
  name?: string;
  status?: string;
  cost?: { input?: number; output?: number };
}

/** Brace depth of a line, ignoring braces inside quoted strings. */
function braceDepth(line: string): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (const ch of line) {
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
    }
  }
  return depth;
}

/** Parse `opencode models opencode --verbose` output: `opencode/<id>\n{json}` blocks. */
export function parseModelsOutput(stdout: string): RawModel[] {
  const models: RawModel[] = [];
  let currentId: string | null = null;
  let jsonLines: string[] = [];
  let depth = 0;

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();

    if (!currentId) {
      const m = trimmed.match(/^opencode\/([\w.-]+)$/);
      if (m) {
        currentId = m[1];
        jsonLines = [];
        depth = 0;
      }
      continue;
    }

    // Header lines ("Models cache refreshed", blank lines, etc.) between blocks.
    if (depth === 0 && !trimmed.startsWith("{")) {
      currentId = null;
      continue;
    }
    if (!trimmed) continue;

    jsonLines.push(trimmed);
    depth += braceDepth(trimmed);

    if (depth <= 0 && jsonLines.length) {
      try {
        models.push({ ...(JSON.parse(jsonLines.join("\n")) as RawModel), id: currentId! });
      } catch {
        // skip malformed block
      }
      currentId = null;
    }
  }
  return models;
}

function reliabilityFor(id: string, status?: string): PublicModel["reliability"] {
  return RELIABILITY_HINTS[id] ?? (status === "active" ? "solid" : "intermittent");
}

/**
 * Refresh the model list from the opencode CLI. Safe to call concurrently —
 * overlapping calls share a single in-flight refresh. Falls back to the
 * current cache on failure.
 */
export async function refreshModels(): Promise<PublicModel[]> {
  // Wait for an in-flight refresh instead of returning a stale cache, so the
  // manual sync endpoint always reflects the freshest list.
  if (refreshing) {
    await refreshing;
    return cache;
  }

  refreshing = (async () => {
    const bin = resolveBinary();
    const proc = spawn({
      cmd: [bin, "models", "opencode", "--refresh", "--verbose"],
      stdout: "pipe",
      // stderr is not consumed — dropping it avoids a pipe-buffer deadlock.
      stderr: "ignore",
    });

    const collect = (async () => {
      let stdout = "";
      for await (const chunk of proc.stdout) stdout += new TextDecoder().decode(chunk);
      return stdout;
    })();

    try {
      // A hung `--refresh` (network stall) must never wedge the registry — kill
      // the child after the timeout and keep the previous list.
      const stdout = await Promise.race([collect, Bun.sleep(config.modelsRefreshTimeoutMs).then(() => "")]);
      const code = await Promise.race([proc.exited, Bun.sleep(2000).then(() => -1)]);
      if (code !== 0) {
        proc.kill();
        throw new Error(stdout ? `opencode models exited with code ${code}` : "opencode models timed out");
      }

      const raw = parseModelsOutput(stdout);
      const fresh = raw
        .filter((m) => m.cost?.input === 0 && m.cost?.output === 0)
        .map(
          (m): PublicModel => ({
            id: m.id,
            label: m.name || m.id,
            backend: { providerID: "opencode", modelID: m.id },
            reliability: reliabilityFor(m.id, m.status),
            cost: { input: 0, output: 0 },
          }),
        );

      if (fresh.length === 0) throw new Error("no free (cost 0) models found");
      cache = fresh;
      lastRefreshAt = Date.now();
      console.log(`[models] refreshed: ${fresh.length} free models from opencode CLI`);
    } catch (e) {
      console.error(
        `[models] refresh failed (keeping ${cache.length} cached models):`,
        e instanceof Error ? e.message : e,
      );
    }
  })();

  try {
    await refreshing;
  } finally {
    refreshing = null;
  }
  return cache;
}

/** Kick off periodic background refreshes. */
export function startModelRefresher(): void {
  void refreshModels();
  setInterval(() => void refreshModels(), config.modelsRefreshMs);
}

export function currentModels(): PublicModel[] {
  return cache;
}

export function findModel(id: string): PublicModel | undefined {
  return cache.find((m) => m.id === id);
}

export function listModels() {
  return cache.map((m) => ({
    id: m.id,
    object: "model",
    created: Math.floor(lastRefreshAt / 1000) || 1779000000,
    owned_by: "OC-NOLIMIT",
  }));
}

/** Metadata about the registry for the dashboard. */
export function modelsMeta() {
  return {
    count: cache.length,
    source: lastRefreshAt > 0 ? "live" : "seed",
    lastRefresh: lastRefreshAt,
    refreshMs: config.modelsRefreshMs,
  };
}
