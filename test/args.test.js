import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../src/main.js';

test('parseArgs handles the task-mode flags', () => {
  const options = parseArgs([
    '--task',
    '--model',
    'openai/gpt-5#high',
    '--opencode',
    '/opt/homebrew/bin/opencode',
    '--attach',
    'ses_abc',
    '--limit',
    '12',
    '--fast',
  ]);
  assert.equal(options.mode, 'task');
  assert.equal(options.model, 'openai/gpt-5#high');
  assert.equal(options.opencode, '/opt/homebrew/bin/opencode');
  assert.equal(options.session, 'ses_abc');
  assert.equal(options.limit, 12);
  assert.equal(options.fast, true);
});

test('parseArgs keeps existing flags backward compatible', () => {
  const options = parseArgs(['--snapshot', '3', '--demo', '--packet-speed', '50', '--no-follow']);
  assert.equal(options.snapshot, 3);
  assert.equal(options.mode, 'demo');
  assert.equal(options.packetSpeed, 50);
  assert.equal(options.follow, false);

  assert.equal(parseArgs(['--picker']).mode, 'picker');
  assert.equal(parseArgs(['--session', 'ses_1']).session, 'ses_1');
});

test('parseArgs accepts positional task text and version', () => {
  assert.equal(parseArgs(['fix', 'the', 'failing', 'tests']).task, 'fix the failing tests');
  assert.equal(parseArgs(['--version']).version, true);
});

test('parseArgs accepts the built-in nolimit command', () => {
  assert.equal(parseArgs(['nolimit', 'start']).nolimit, 'start');
  assert.equal(parseArgs(['nolimit']).nolimit, 'status');
});

test('parseArgs rejects missing and invalid flag values', () => {
  assert.throws(() => parseArgs(['--model']), /Missing value for --model/);
  assert.throws(() => parseArgs(['--limit', 'abc']), /--limit expects a positive integer/);
  assert.throws(() => parseArgs(['--packet-speed', '5']), /--packet-speed must be at least 20/);
});
test('parseArgs accepts --new/--fresh and task-mode --session', () => {
  const fresh = parseArgs(['--task', '--new']);
  assert.equal(fresh.fresh, true);
  const fresh2 = parseArgs(['--task', '--fresh']);
  assert.equal(fresh2.fresh, true);
  const noFresh = parseArgs(['--task']);
  assert.equal(noFresh.fresh, false);
  const withSession = parseArgs(['--session', 'ses_xyz']);
  assert.equal(withSession.session, 'ses_xyz');
});

test('parseArgs defaults auto=false and honors --auto/--no-auto (last wins)', () => {
  assert.equal(parseArgs(['--task']).auto, false);
  assert.equal(parseArgs(['--task', '--auto']).auto, true);
  assert.equal(parseArgs(['--task', '--no-auto']).auto, false);
  assert.equal(parseArgs(['--no-auto', '--auto']).auto, true);
  assert.equal(parseArgs(['--auto', '--no-auto']).auto, false);
});

test('parseArgs supports --parallel/--workers/--sequential', () => {
  assert.equal(parseArgs(['--task']).parallel, false);
  assert.equal(parseArgs(['--parallel']).parallel, true);
  assert.equal(parseArgs(['--workers', '5']).workers, 5);
  assert.equal(parseArgs(['--workers', '5']).parallel, true);
  assert.equal(parseArgs(['--sequential']).sequential, true);
  assert.equal(parseArgs(['--sequential']).parallel, false);
  assert.equal(parseArgs(['--resume', '/tmp/x']).resume, '/tmp/x');
  assert.throws(() => parseArgs(['--workers']), /Missing value for --workers/);
  assert.throws(() => parseArgs(['--resume']), /Missing value for --resume/);
});
