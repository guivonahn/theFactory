import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { config } from "./config";

/**
 * API keys are kept in a JSON file. There is exactly one key, generated on
 * first start, so clients can rely on the same key between restarts. It can
 * be rotated at any time (`POST /api/keys/rotate`) — old keys stop working.
 */

const DEFAULT_LABEL = "default";

type KeyStore = Record<string, string>;

let store: KeyStore = load();

function freshKeys(): KeyStore {
  return { [DEFAULT_LABEL]: `oc-${randomBytes(20).toString("hex")}` };
}

function load(): KeyStore {
  try {
    if (existsSync(config.keysFile)) {
      const parsed = JSON.parse(readFileSync(config.keysFile, "utf8")) as KeyStore;
      // Prefer an existing single key (stable across restarts). If an old
      // multi-key file exists, keep the first key and drop the rest.
      const values = Object.values(parsed).filter(Boolean);
      if (values.length > 0) {
        // Normalize to a single "default" key — rewrite legacy multi-key files
        // (or single keys stored under an old label) so disk matches runtime.
        const migrated = { [DEFAULT_LABEL]: values[0] };
        if (JSON.stringify(parsed) !== JSON.stringify(migrated)) persist(migrated);
        return migrated;
      }
    }
  } catch {
    // fall through and regenerate
  }
  const fresh = freshKeys();
  persist(fresh);
  console.log(`[keys] generated new API key → ${config.keysFile}`);
  return fresh;
}

function persist(keys: KeyStore): void {
  mkdirSync(dirname(config.keysFile), { recursive: true });
  writeFileSync(config.keysFile, JSON.stringify(keys, null, 2), { mode: 0o600 });
  chmodSync(config.keysFile, 0o600);
}

/** Validate a request and return the key label, or null when unauthorized. */
export function authenticate(req: Request): string | null {
  const header = req.headers.get("authorization") || req.headers.get("x-api-key") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : header.trim();
  if (!token) return null;
  for (const [label, key] of Object.entries(store)) {
    if (token === key) return label;
  }
  return null;
}

export function allKeys(): KeyStore {
  return { ...store };
}

export function rotateKeys(): KeyStore {
  store = freshKeys();
  persist(store);
  return allKeys();
}
