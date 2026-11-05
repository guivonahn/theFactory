import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  openSync,
  closeSync,
  chmodSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NOLIMIT_DIR = join(PROJECT_DIR, 'vendor', 'opencode-nolimit');
const STATE_DIR = join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'thefactory', 'nolimit');
const PID_FILE = join(STATE_DIR, 'server.pid');
const LOG_FILE = join(STATE_DIR, 'server.log');
const KEYS_FILE = join(NOLIMIT_DIR, 'data', 'keys.json');
const PORT = Number(process.env.FACTORY_NOLIMIT_PORT || 6446);

function bunBinary() {
  const candidates = [
    process.env.BUN,
    process.env.HOME ? join(process.env.HOME, '.bun', 'bin', 'bun') : null,
    '/opt/homebrew/bin/bun',
    '/usr/local/bin/bun',
  ].filter(Boolean);
  const candidate = candidates.find((candidate) => existsSync(candidate));
  if (candidate) return candidate;
  const pathBinary = (process.env.PATH || '').split(':').map((dir) => join(dir, 'bun')).find(existsSync);
  return pathBinary || null;
}

function opencodeBinary() {
  const candidates = [
    process.env.FACTORY_OPENCODE,
    process.env.HOME ? join(process.env.HOME, '.bun', 'bin', 'opencode') : null,
    '/opt/homebrew/bin/opencode',
    '/usr/local/bin/opencode',
  ].filter(Boolean);
  const candidate = candidates.find((candidate) => existsSync(candidate));
  if (candidate) return candidate;
  return (process.env.PATH || '').split(':').map((dir) => join(dir, 'opencode')).find(existsSync) || null;
}

async function health() {
  try {
    const response = await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    return false;
  }
}

function readPid() {
  try {
    return Number(readFileSync(PID_FILE, 'utf8').trim());
  } catch {
    return null;
  }
}

function processIsRunning(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function apiKey() {
  // Proxy may run from the parent checkout (vendor/ + data/ only exist there).
  // Try worktree-local keys first, then the parent repo's keys.
  const candidates = [
    KEYS_FILE,
    join(PROJECT_DIR, '..', 'vendor', 'opencode-nolimit', 'data', 'keys.json'),
    join(PROJECT_DIR, '..', '..', 'vendor', 'opencode-nolimit', 'data', 'keys.json'),
  ];
  for (const candidate of candidates) {
    try {
      const keys = JSON.parse(readFileSync(candidate, 'utf8'));
      const value = Object.values(keys)[0];
      if (value) return value;
    } catch {}
  }
  return null;
}

function configureOpenCode() {
  const key = apiKey();
  if (!key) return;
  const configDir = process.env.XDG_CONFIG_HOME
    ? join(process.env.XDG_CONFIG_HOME, 'opencode')
    : join(homedir(), '.config', 'opencode');
  const configFile = join(configDir, 'opencode.json');
  if (!existsSync(configFile)) return;
  const configMode = existsSync(configFile) ? 0o600 : 0o600;
  chmodSync(configFile, configMode);

  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  config.provider ??= {};
  config.provider['OC-NOLIMIT'] = {
    type: 'openai',
    apiKey: key,
    baseURL: `http://127.0.0.1:${PORT}/v1`,
    models: {
      'deepseek-v4-flash-free': { id: 'deepseek-v4-flash-free', name: 'DeepSeek V4 Flash (Free)' },
      'big-pickle': { id: 'big-pickle', name: 'Big Pickle (Free)' },
      'hy3-free': { id: 'hy3-free', name: 'Hy3 (Free)' },
      'laguna-s-2.1-free': { id: 'laguna-s-2.1-free', name: 'Laguna S 2.1 (Free)' },
      'nemotron-3.5-lightning-free': { id: 'nemotron-3.5-lightning-free', name: 'Nemotron 3.5 Lightning (Free)' },
      'mimo-v2.5-free': { id: 'mimo-v2.5-free', name: 'MiniMax M2.5 (Free)' },
      'nemotron-3-ultra-free': { id: 'nemotron-3-ultra-free', name: 'Nemotron 3 Ultra (Free)' },
      'ling-3.0-tiny-free': { id: 'ling-3.0-tiny-free', name: 'Ling 3.0 Tiny (Free)' },
    },
  };
  config.experimental ??= {};
  config.experimental.policies ??= [];
  const allow = config.experimental.policies.find(
    (policy) => policy.action === 'provider.use' && policy.resource === 'OC-NOLIMIT',
  );
  if (!allow) {
    config.experimental.policies.push({ action: 'provider.use', resource: 'OC-NOLIMIT', effect: 'allow' });
  } else {
    allow.effect = 'allow';
  }
  // Idempotently ensure the narrow workin_on external_directory allow exists
  // in the live global config (template: config/opencode/opencode.json).
  // Last-match-wins: insert after `external_directory *:ask` when missing.
  // Never add a global allow-all or a broad /Users/guivonahn/* rule.
  config.permissions ??= [];
  const WORKIN_ON = '/Users/guivonahn/Documents/Code/theFactory/workin_on/*';
  const hasWorkinOn = config.permissions.some(
    (perm) => perm.action === 'external_directory' && perm.resource === WORKIN_ON,
  );
  if (!hasWorkinOn && config.permissions.length > 0) {
    const askIndex = config.permissions.findIndex(
      (perm) => perm.action === 'external_directory' && perm.resource === '*' && perm.effect === 'ask',
    );
    const entry = { action: 'external_directory', resource: WORKIN_ON, effect: 'allow' };
    if (askIndex >= 0) config.permissions.splice(askIndex + 1, 0, entry);
    else config.permissions.push(entry);
  }
  // OC-NOLIMIT models declare no variants; agent models with `#high` fail
  // with `Variant unavailable`. Strip variants for OC-NOLIMIT agent models only.
  if (config.agents && typeof config.agents === 'object') {
    for (const agent of Object.values(config.agents)) {
      if (typeof agent?.model === 'string' && agent.model.startsWith('OC-NOLIMIT/') && agent.model.includes('#')) {
        agent.model = agent.model.split('#')[0];
      }
    }
  }
  if (typeof config.model === 'string' && config.model.startsWith('OC-NOLIMIT/') && config.model.includes('#')) {
    config.model = config.model.split('#')[0];
  }
  writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);
}

async function dependenciesReady() {
  return Boolean(bunBinary() && opencodeBinary());
}

export async function ensureNolimit() {
  if (await health()) {
    configureOpenCode();
    return { ok: true };
  }
  if (!await dependenciesReady()) {
    return {
      ok: false,
      error: 'Bun and the OpenCode CLI are required; install them explicitly and run the task again',
    };
  }

  const bun = bunBinary();
  const opencode = opencodeBinary();
  if (!bun || !opencode) {
    return { ok: false, error: 'Bun or the OpenCode CLI is unavailable for opencode-nolimit' };
  }

  mkdirSync(STATE_DIR, { recursive: true });
  mkdirSync(dirname(KEYS_FILE), { recursive: true });
  const log = openSync(LOG_FILE, 'a');
  const child = spawn(bun, ['run', join(NOLIMIT_DIR, 'src', 'index.ts')], {
    cwd: NOLIMIT_DIR,
    env: {
      ...process.env,
      PROXY_PORT: String(PORT),
      KEYS_FILE,
      OPENCODE_BIN: opencode,
    },
    detached: true,
    stdio: ['ignore', log, log],
  });
  closeSync(log);
  child.unref();
  writeFileSync(PID_FILE, `${child.pid}\n`);

  for (let attempt = 0; attempt < 60; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (await health()) {
      configureOpenCode();
      return { ok: true };
    }
  }
  return { ok: false, error: `opencode-nolimit failed to start; see ${LOG_FILE}` };
}

export async function nolimitCommand(action = 'status') {
  if (!['start', 'stop', 'restart', 'status', 'key', 'models'].includes(action)) {
    process.stderr.write(`Unknown nolimit action: ${action}\n`);
    return 1;
  }

  if (action === 'status') {
    if (await health()) {
      process.stdout.write(`● opencode-nolimit running at http://127.0.0.1:${PORT}\n`);
      return 0;
    }
    process.stdout.write('○ opencode-nolimit stopped\n');
    return 1;
  }

  if (action === 'key') {
    const key = apiKey();
    process.stdout.write(key ? `${key}\n` : 'No API key yet. Start opencode-nolimit first.\n');
    return key ? 0 : 1;
  }

  if (action === 'models') {
    if (!(await health())) {
      process.stderr.write('opencode-nolimit is not running.\n');
      return 1;
    }
    const response = await fetch(`http://127.0.0.1:${PORT}/v1/models`);
    if (!response.ok) return 1;
    const data = await response.json();
    for (const model of data.data || []) process.stdout.write(`${model.id}\n`);
    return 0;
  }

  if (action === 'stop' || action === 'restart') {
    const pid = readPid();
    if (pid && processIsRunning(pid)) process.kill(pid, 'SIGTERM');
    if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
    for (let attempt = 0; attempt < 30 && await health(); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    process.stdout.write('Stopped opencode-nolimit.\n');
    if (action === 'stop') return await health() ? 1 : 0;
  }

  if (await health()) {
    process.stdout.write(`opencode-nolimit already running at http://127.0.0.1:${PORT}\n`);
    return 0;
  }
  const result = await ensureNolimit();
  if (!result.ok) {
    process.stderr.write(`${result.error}\n`);
    return 1;
  }
  process.stdout.write(`Started opencode-nolimit at http://127.0.0.1:${PORT}\n`);
  process.stdout.write(`API key: ${apiKey()}\n`);
  return 0;
}
