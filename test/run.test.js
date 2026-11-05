import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseRunLine, argsForRun } from '../src/run.js';

const fixture = fs
  .readFileSync(new URL('./runLine.fixture.jsonl', import.meta.url), 'utf8')
  .trim()
  .split('\n');

test('parseRunLine captures the first session id and text part', () => {
  const start = parseRunLine(fixture[0]);
  assert.equal(start.sessionID, 'ses_e53df373dffeHaVK56ZTPzw3d8');
  assert.equal(start.type, 'step_start');
  assert.equal(start.events.length, 0);

  const text = parseRunLine(fixture[1]);
  assert.equal(text.sessionID, 'ses_e53df373dffeHaVK56ZTPzw3d8');
  assert.equal(text.text, 'PONG');
  assert.equal(text.events.length, 1);
  assert.equal(text.events[0].kind, 'status');
  assert.match(text.events[0].text, /PONG/);
});

test('parseRunLine is tolerant of garbage and maps tool fan-out', () => {
  assert.equal(parseRunLine('not json'), null);
  assert.equal(parseRunLine(''), null);

  const tool = parseRunLine(
    JSON.stringify({
      type: 'tool',
      sessionID: 'ses_123',
      part: {
        type: 'tool',
        tool: 'task',
        state: { input: { subagent_type: 'explorer' } },
      },
    }),
  );
  assert.equal(tool.sessionID, 'ses_123');
  assert.equal(tool.tool, 'task');
  assert.equal(tool.events[0].kind, 'tool');
  assert.equal(tool.events[0].fanout, true);
  assert.equal(tool.events[0].to, 'explorer');
});

test('argsForRun passes --session for a continued session', () => {
  const args = argsForRun({ task: 'hello', sessionID: 'ses_123', model: 'x/y' });
  assert.deepEqual(args, ['run', '--format', 'json', '--session', 'ses_123', '-m', 'x/y', 'hello']);
});

test('argsForRun defaults to a brand-new session and supports --continue', () => {
  assert.deepEqual(argsForRun({ task: 'hello' }), ['run', '--format', 'json', 'hello']);
  assert.deepEqual(argsForRun({ task: 'hello', continue: true }), ['run', '--format', 'json', '--continue', 'hello']);
});
