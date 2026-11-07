/**
 * Sound effects: `pop.mp3` when an agent is called, `error.mp3` on errors,
 * with a persisted 0-100 volume (0 = muted).
 *
 * Zero dependencies. Playback is detached and fire-and-forget so a missing
 * sound file or audio player never breaks the TUI render loop. Volume is
 * passed to the player itself (`afplay -v`, `ffplay -volume`, …) rather
 * than touching the OS output volume.
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { constants as fsConstants, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { accessSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SOUND_FILES = Object.freeze({
  pop: 'pop.mp3',
  error: 'error.mp3',
  completed: 'completed.mp3',
});

export const DEFAULT_VOLUME = 80;
export const MIN_VOLUME = 0;
export const MAX_VOLUME = 100;

/** Volume steps used by the `/config` card cycle. */
export const VOLUME_PRESETS = Object.freeze([0, 25, 50, 80, 100]);

const DISABLE_VALUES = new Set(['0', 'false', 'off', 'no', 'mute']);
const ENABLE_VALUES = new Set(['1', 'true', 'on', 'yes']);

const PLAYER_PREFERENCE = Object.freeze({
  darwin: ['afplay', 'ffplay', 'mpv', 'mpg123'],
  linux: ['ffplay', 'mpv', 'mpg123'],
  win32: ['ffplay', 'mpv', 'mpg123', 'powershell'],
});
const DEFAULT_PREFERENCE = ['ffplay', 'mpv', 'mpg123', 'afplay'];

/** Bundled sounds directory, overridable with FACTORY_SOUNDS_DIR. */
export function defaultSoundsDir() {
  if (process.env.FACTORY_SOUNDS_DIR) return process.env.FACTORY_SOUNDS_DIR;
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'sounds');
}

/** Path of the persisted volume file, honouring XDG_STATE_HOME. */
export function persistedSoundPath() {
  const base = process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state');
  return join(base, 'thefactory', 'sound.json');
}

/** Load the persisted volume, or null when unset/corrupt. */
export function loadPersistedVolume() {
  try {
    const data = JSON.parse(readFileSync(persistedSoundPath(), 'utf8'));
    return normalizeVolume(data?.volume);
  } catch {
    return null;
  }
}

/** Persist a volume for the next start. Never throws. */
export function savePersistedVolume(volume) {
  const next = normalizeVolume(volume);
  if (next === null) return;
  try {
    const path = persistedSoundPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify({ volume: next, updatedAt: new Date().toISOString() }, null, 2)}\n`);
  } catch {
    // Persistence must never break a task run.
  }
}

/** True unless FACTORY_SOUND / FACTORY_MUTE explicitly disables sound. */
export function envSoundEnabled(env = process.env) {
  const sound = String(env?.FACTORY_SOUND ?? '').trim().toLowerCase();
  if (DISABLE_VALUES.has(sound)) return false;
  if (ENABLE_VALUES.has(sound)) return true;
  const mute = String(env?.FACTORY_MUTE ?? '').trim().toLowerCase();
  if (ENABLE_VALUES.has(mute)) return false;
  if (DISABLE_VALUES.has(mute)) return true;
  return true;
}

/** FACTORY_VOLUME as 0-100, or null when unset/invalid. */
export function envVolume(env = process.env) {
  if (env?.FACTORY_VOLUME == null) return null;
  return normalizeVolume(env.FACTORY_VOLUME);
}

/**
 * Normalise a volume into an integer 0-100, or null when invalid.
 * Accepts 50, "50", "50%", and 0-1 decimals ("0.5" → 50). Numbers above
 * 100 (other than the 0-1 decimal range) are invalid.
 */
export function normalizeVolume(value) {
  if (value == null) return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    if (value >= 0 && value <= 1 && !Number.isInteger(value) && value > 0 && value < 1) {
      return Math.round(value * 100);
    }
    if (!Number.isInteger(value)) return null;
    return value >= MIN_VOLUME && value <= MAX_VOLUME ? value : null;
  }
  const text = String(value).trim();
  if (!text) return null;
  if (/^(0\.\d+|1(\.0+)?)$/.test(text)) {
    const parsed = Number(text);
    return parsed <= 1 ? Math.round(parsed * 100) : null;
  }
  const match = text.match(/^(\d+)\s*%?$/);
  if (!match) return null;
  const parsed = Number.parseInt(match[1], 10);
  return parsed >= MIN_VOLUME && parsed <= MAX_VOLUME ? parsed : null;
}

export function formatVolume(volume) {
  const next = normalizeVolume(volume);
  if (next === null) return String(volume ?? '');
  return next === 0 ? 'muted (0)' : `${next}%`;
}

/**
 * Parse the argument text of a `/volume` command against `current` volume.
 * Returns `{ action: 'show', volume }`, `{ action: 'set', volume }`, or
 * `{ action: 'error', volume: current, message }`.
 */
export function parseVolumeCommand(input, current) {
  const currentVolume = normalizeVolume(current) ?? DEFAULT_VOLUME;
  const text = String(input ?? '').replace(/^\s*\/volume\b/i, '').trim();
  const show = (message) => ({ action: 'show', volume: currentVolume, message });
  if (!text) {
    return show(`volume ${formatVolume(currentVolume)} · usage: /volume <0-100|mute|on|off|+n|-n>`);
  }
  const lowered = text.toLowerCase();
  if (lowered === 'mute' || lowered === 'off') return { action: 'set', volume: 0, message: 'sound muted' };
  if (lowered === 'on' || lowered === 'unmute') {
    const next = currentVolume === 0 ? DEFAULT_VOLUME : currentVolume;
    return { action: 'set', volume: next, message: `sound on · volume ${formatVolume(next)}` };
  }
  if (lowered === 'max') return { action: 'set', volume: MAX_VOLUME, message: `volume ${formatVolume(MAX_VOLUME)}` };
  if (lowered === 'min') return { action: 'set', volume: MIN_VOLUME, message: 'sound muted' };
  const relative = text.match(/^([+-])\s*(\d+)\s*%?$/);
  if (relative) {
    const delta = Number.parseInt(relative[2], 10) * (relative[1] === '-' ? -1 : 1);
    const next = Math.max(MIN_VOLUME, Math.min(MAX_VOLUME, currentVolume + delta));
    return { action: 'set', volume: next, message: `volume ${formatVolume(next)}` };
  }
  const next = normalizeVolume(text);
  if (next === null) {
    return {
      action: 'error',
      volume: currentVolume,
      message: `! volume expects 0-100, mute/on/off, or +n/-n (got "${text}")`,
    };
  }
  return { action: 'set', volume: next, message: `volume ${formatVolume(next)}` };
}

/** First preferred player present in `available`, or null. */
export function resolvePlayer(platform = process.platform, available = []) {
  const preferred = PLAYER_PREFERENCE[platform] ?? DEFAULT_PREFERENCE;
  const set = new Set(Array.isArray(available) ? available : [available]);
  for (const player of preferred) {
    if (set.has(player)) return player;
  }
  return null;
}

/** Find a player executable on PATH, or null. */
export function findExecutable(name, env = process.env) {
  const paths = String(env?.PATH ?? '').split(delimiter).filter(Boolean);
  const candidates = process.platform === 'win32' ? [`${name}.exe`, name] : [name];
  for (const dir of paths) {
    for (const candidate of candidates) {
      try {
        accessSync(join(dir, candidate), fsConstants.X_OK);
        return join(dir, candidate);
      } catch {
        // Not executable here; keep searching.
      }
    }
  }
  return null;
}

/** All known players found on PATH, in preference order for `platform`. */
export function availablePlayers(platform = process.platform, env = process.env) {
  const preferred = PLAYER_PREFERENCE[platform] ?? DEFAULT_PREFERENCE;
  return preferred.filter((player) => findExecutable(player, env));
}

/**
 * Build the playback command for `player` + `file` at `volume` (0-100).
 * Returns `{ command, args }` or null when the player is unknown.
 */
export function soundCommandFor(player, file, volume) {
  const level = normalizeVolume(volume) ?? DEFAULT_VOLUME;
  const base = String(player ?? '').split(/[\\/]/).pop()?.toLowerCase() ?? '';
  if (base === 'afplay') return { command: player, args: ['-v', String(level / 100), file] };
  if (base === 'ffplay') {
    return { command: player, args: ['-nodisp', '-autoexit', '-loglevel', 'quiet', '-volume', String(level), file] };
  }
  if (base === 'mpv') return { command: player, args: ['--no-video', '--really-quiet', `--volume=${level}`, file] };
  if (base === 'mpg123') {
    return { command: player, args: ['-q', '-f', String(Math.round(32768 * (level / 100))), file] };
  }
  if (base === 'powershell' || base === 'powershell.exe') {
    const escaped = String(file).replace(/'/g, "''");
    return { command: player, args: ['-Command', `(New-Object Media.SoundPlayer -ArgumentList '${escaped}').Play()`] };
  }
  return null;
}

/** Preferred volume precedence: explicit option > env > persisted > default. */
export function initialVolume(options = {}) {
  const explicit = normalizeVolume(options.volume);
  if (explicit !== null) return explicit;
  const fromEnv = envVolume(options.env ?? process.env);
  if (fromEnv !== null) return fromEnv;
  const persisted = options.persistedVolume === undefined
    ? loadPersistedVolume()
    : options.persistedVolume;
  const fromPersisted = normalizeVolume(persisted);
  if (fromPersisted !== null) return fromPersisted;
  return DEFAULT_VOLUME;
}

/**
 * Create a sound player.
 * `options`: { volume, enabled, soundsDir, platform, player (force),
 *   spawnImpl, now, cooldowns ({pop, error}), env }
 */
export function createSoundPlayer(options = {}) {
  const platform = options.platform ?? process.platform;
  const soundsDir = options.soundsDir ?? defaultSoundsDir();
  const spawnImpl = options.spawnImpl ?? nodeSpawn;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const cooldowns = { pop: 150, error: 600, ...(options.cooldowns ?? {}) };
  let volume = initialVolume({
    volume: options.volume,
    env: options.env,
    persistedVolume: options.persistedVolume,
  });
  let enabled = options.enabled ?? envSoundEnabled(options.env ?? process.env);
  let lastErrorLogged = '';
  const lastPlayed = new Map();

  const fileFor = (name) => {
    const file = SOUND_FILES[name];
    return file ? join(soundsDir, file) : null;
  };

  const playerExecutable = () => {
    if (options.player) return options.player;
    const env = options.env ?? process.env;
    const available = availablePlayers(platform, env);
    const chosen = resolvePlayer(platform, available);
    return chosen ? (findExecutable(chosen, env) ?? chosen) : null;
  };

  function play(name) {
    const file = fileFor(name);
    if (!file) return { ok: false, reason: 'unknown-sound' };
    if (!enabled || volume <= 0) return { ok: false, reason: 'muted' };
    const cooldown = cooldowns[name] ?? 150;
    const at = now();
    const previous = lastPlayed.get(name);
    if (previous != null && at - previous < cooldown) return { ok: false, reason: 'throttled' };
    // Missing bundle files are not fatal: log once via onError, skip silently.
    if (!existsSync(file)) {
      const message = `sound file missing: ${file}`;
      if (message !== lastErrorLogged) {
        lastErrorLogged = message;
        try { options.onError?.(message); } catch {}
      }
      return { ok: false, reason: 'missing-file', file };
    }
    const player = playerExecutable();
    const command = player ? soundCommandFor(player, file, volume) : null;
    if (!command) return { ok: false, reason: 'no-player' };
    let child;
    try {
      child = spawnImpl(command.command, command.args, { detached: true, stdio: 'ignore' });
    } catch (error) {
      return { ok: false, reason: 'spawn-failed', error: String(error?.message ?? error) };
    }
    try { child?.on?.('error', () => {}); } catch {}
    try { child?.unref?.(); } catch {}
    lastPlayed.set(name, at);
    return { ok: true, file, command: command.command, args: command.args };
  }

  return {
    getVolume: () => volume,
    setVolume: (next) => {
      const normalized = normalizeVolume(next);
      if (normalized === null) return null;
      volume = normalized;
      if (normalized > 0) enabled = true;
      return volume;
    },
    isEnabled: () => enabled,
    setEnabled: (next) => { enabled = Boolean(next); return enabled; },
    fileFor,
    play,
    playPop: () => play('pop'),
    playError: () => play('error'),
    soundsDir,
    platform,
  };
}
