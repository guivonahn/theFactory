import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  SOUND_FILES,
  createSoundPlayer,
  defaultSoundsDir,
  envSoundEnabled,
  formatVolume,
  initialVolume,
  normalizeVolume,
  parseVolumeCommand,
  resolvePlayer,
  soundCommandFor,
} from '../src/sound.js';

test('bundled sounds exist in the sounds directory', () => {
  const dir = defaultSoundsDir();
  for (const file of Object.values(SOUND_FILES)) {
    assert.equal(existsSync(join(dir, file)), true, `${file} is bundled`);
  }
});

test('normalizeVolume accepts ints, percent and 0-1 decimals, rejects out of range', () => {
  assert.equal(normalizeVolume(50), 50);
  assert.equal(normalizeVolume('50'), 50);
  assert.equal(normalizeVolume('50%'), 50);
  assert.equal(normalizeVolume(0), 0);
  assert.equal(normalizeVolume(100), 100);
  assert.equal(normalizeVolume('0.5'), 50);
  assert.equal(normalizeVolume(0.25), 25);
  assert.equal(normalizeVolume(-1), null);
  assert.equal(normalizeVolume(101), null);
  assert.equal(normalizeVolume('120%'), null);
  assert.equal(normalizeVolume('loud'), null);
  assert.equal(normalizeVolume(''), null);
  assert.equal(normalizeVolume(null), null);
  assert.equal(formatVolume(80), '80%');
  assert.equal(formatVolume(0), 'muted (0)');
});

test('parseVolumeCommand handles show, set, mute, relative and errors', () => {
  assert.equal(parseVolumeCommand('', 50).action, 'show');
  assert.deepEqual(parseVolumeCommand('/volume', 50), {
    action: 'show', volume: 50, message: parseVolumeCommand('/volume', 50).message,
  });
  assert.equal(parseVolumeCommand('/volume 30', 50).volume, 30);
  assert.equal(parseVolumeCommand('/volume 30%', 50).volume, 30);
  assert.equal(parseVolumeCommand('/volume mute', 50).volume, 0);
  assert.equal(parseVolumeCommand('/volume off', 50).volume, 0);
  assert.equal(parseVolumeCommand('/volume on', 0).volume, 80);
  assert.equal(parseVolumeCommand('/volume on', 40).volume, 40);
  assert.equal(parseVolumeCommand('/volume +10', 95).volume, 100);
  assert.equal(parseVolumeCommand('/volume -10', 5).volume, 0);
  assert.equal(parseVolumeCommand('/volume 200', 50).action, 'error');
  assert.equal(parseVolumeCommand('/volume banana', 50).action, 'error');
  assert.equal(parseVolumeCommand('/volume banana', 50).volume, 50);
});

test('envSoundEnabled honors FACTORY_SOUND and FACTORY_MUTE', () => {
  assert.equal(envSoundEnabled({}), true);
  assert.equal(envSoundEnabled({ FACTORY_SOUND: '0' }), false);
  assert.equal(envSoundEnabled({ FACTORY_SOUND: 'off' }), false);
  assert.equal(envSoundEnabled({ FACTORY_MUTE: '1' }), false);
  assert.equal(envSoundEnabled({ FACTORY_SOUND: '1' }), true);
});

test('initialVolume prefers explicit over env over persisted', () => {
  assert.equal(initialVolume({ volume: 20, env: { FACTORY_VOLUME: '30' }, persistedVolume: 40 }), 20);
  assert.equal(initialVolume({ env: { FACTORY_VOLUME: '30' }, persistedVolume: 40 }), 30);
  assert.equal(initialVolume({ env: {}, persistedVolume: 40 }), 40);
  assert.equal(initialVolume({ env: {}, persistedVolume: null }), 80);
});

test('resolvePlayer picks the platform preference', () => {
  assert.equal(resolvePlayer('darwin', ['ffplay', 'afplay']), 'afplay');
  assert.equal(resolvePlayer('linux', ['mpg123', 'ffplay']), 'ffplay');
  assert.equal(resolvePlayer('linux', []), null);
});

test('soundCommandFor builds per-player volume args', () => {
  assert.deepEqual(soundCommandFor('afplay', '/x/pop.mp3', 50), {
    command: 'afplay', args: ['-v', '0.5', '/x/pop.mp3'],
  });
  assert.deepEqual(soundCommandFor('/usr/bin/ffplay', '/x/pop.mp3', 80), {
    command: '/usr/bin/ffplay',
    args: ['-nodisp', '-autoexit', '-loglevel', 'quiet', '-volume', '80', '/x/pop.mp3'],
  });
  assert.deepEqual(soundCommandFor('mpv', '/x/error.mp3', 100), {
    command: 'mpv', args: ['--no-video', '--really-quiet', '--volume=100', '/x/error.mp3'],
  });
  assert.deepEqual(soundCommandFor('mpg123', '/x/pop.mp3', 50), {
    command: 'mpg123', args: ['-q', '-f', '16384', '/x/pop.mp3'],
  });
  assert.equal(soundCommandFor('nope', '/x/pop.mp3', 50), null);
});

test('player spawns detached, throttles repeats and stays silent when muted', () => {
  const calls = [];
  let at = 1000;
  const player = createSoundPlayer({
    volume: 80,
    soundsDir: defaultSoundsDir(),
    player: 'afplay',
    now: () => at,
    spawnImpl: (command, args, opts) => {
      calls.push({ command, args, opts });
      return { unref() {}, on() {} };
    },
  });
  assert.equal(player.play('pop').ok, true);
  assert.equal(player.play('pop').reason, 'throttled'); // same tick
  at += 200;
  assert.equal(player.play('pop').ok, true);
  assert.equal(player.play('error').ok, true);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].opts.detached, true);
  assert.deepEqual(calls[0].args, ['-v', '0.8', player.fileFor('pop')]);

  assert.equal(player.setVolume(0), 0);
  assert.equal(player.play('pop').ok, false);
  assert.equal(calls.length, 3); // muted: no new spawn
  assert.equal(player.setVolume(50), 50);
  at += 1000;
  assert.equal(player.play('pop').ok, true);
});

test('player reports unknown sounds and missing bundle files without throwing', () => {
  const player = createSoundPlayer({
    soundsDir: '/definitely/not/here',
    player: 'afplay',
    spawnImpl: () => { throw new Error('must not spawn'); },
  });
  assert.equal(player.play('bell').ok, false);
  assert.equal(player.play('pop').reason, 'missing-file');
});

test('player honors enabled=false (CLI --mute / FACTORY_SOUND=0)', () => {
  let spawned = 0;
  const player = createSoundPlayer({
    enabled: false,
    soundsDir: defaultSoundsDir(),
    player: 'afplay',
    spawnImpl: () => { spawned += 1; return { unref() {}, on() {} }; },
  });
  assert.equal(player.play('pop').ok, false);
  assert.equal(spawned, 0);
  player.setEnabled(true);
  assert.equal(player.play('pop').ok, true);
  assert.equal(spawned, 1);
});

test('App cues pop on agent calls and error on failures (silent by default)', async () => {
  const { App } = await import('../src/app.js');
  const cues = [];
  const app = new App({ width: 120, height: 40, onSound: (name) => cues.push(name) });
  assert.equal(app.onSound != null, true);
  app.applyEvent({ kind: 'msg', from: 'orchestrator', to: 'developer', dir: 'out', text: 'build it' });
  app.applyEvent({ kind: 'msg', from: 'developer', dir: 'in', text: 'done' });
  app.applyEvent({ kind: 'tool', from: 'orchestrator', text: 'subagent: deepseek', fanout: true });
  app.applyEvent({ kind: 'tool', from: 'developer', text: 'edit src/app.js' });
  app.applyEvent({ kind: 'status', from: 'developer', text: '✗ failed: oops' });
  app.finishRun('error', 'boom');
  assert.deepEqual(cues, ['pop', 'pop', 'pop', 'error', 'error']);

  // Default App (snapshot/tests/backfill) has no hook and never throws.
  const quiet = new App({ width: 120, height: 40 });
  assert.equal(quiet.onSound, null);
  assert.doesNotThrow(() => {
    quiet.applyEvent({ kind: 'msg', from: 'orchestrator', to: 'developer', dir: 'out', text: 'build' });
    quiet.finishRun('error', 'boom');
  });
});
