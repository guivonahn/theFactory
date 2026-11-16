import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from '../src/main.js';

function fixture(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-launch-'));
  const file = path.join(dir, 'request.json');
  const request = { version: 1, directory: dir, prompt: 'Build it', profile: 'saved', execution: 'standard' };
  const write = (value) => fs.writeFileSync(file, JSON.stringify(value));
  try { write(request); run({ dir, file, request, write }); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('menu launch preserves literal multiline prompt and sets a fresh automatic task', () => fixture(({ file, request, write }) => {
  const prompt = '/path with spaces\n  Unicode: 工場 🏭\n$(touch NEVER) `echo nope` \'quoted\' --demo';
  write({ ...request, prompt, model: 'fixture/model#high', agentModels: { developer: 'fixture/code#low' }, execution: 'parallel', workers: 4, auto: false, muted: true });
  const result = parseArgs(['--launch-request', file]);
  assert.equal(result.task, prompt);
  assert.equal(result.mode, 'task');
  assert.equal(result.start, true);
  assert.equal(result.fresh, true);
  assert.equal(result.model, 'fixture/model#high');
  assert.deepEqual(result.menuAgentModels, { developer: 'fixture/code#low' });
  assert.equal(result.parallel, true);
  assert.equal(result.workers, 4);
  assert.equal(result.auto, false);
  assert.equal(result.mute, true);
  assert.equal(result.profileExplicit, false);
}));

test('menu launch validates settings before starting anything', () => fixture(({ file, request, write }) => {
  for (const invalid of [{ profile: 'invented' }, { workers: 100 }, { workers: 1.2 }, { auto: 'true' }, { model: 'bad model' }, { agentModels: { unknown: 'fixture/model' } }, { prompt: '' }, { version: 2 }]) {
    write({ ...request, ...invalid });
    assert.throws(() => parseArgs(['--launch-request', file]));
  }
  assert.throws(() => parseArgs(['--launch-request', file, '--auto']), /exactly one/);
}));

test('ordinary positional prompts remain prefilled until Enter', () => {
  const options = parseArgs(['A normal task']);
  assert.equal(options.task, 'A normal task');
  assert.equal(options.start, undefined);
});
