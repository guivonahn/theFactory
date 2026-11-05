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

test('argsForRun omits --auto by default and includes it only with auto:true (opt-in)', () => {
  assert.deepEqual(argsForRun({ task: 'hello', auto: true }), ['run', '--format', 'json', '--auto', 'hello']);
  assert.deepEqual(argsForRun({ task: 'hello', auto: false }), ['run', '--format', 'json', 'hello']);
  assert.deepEqual(
    argsForRun({ task: 'hello', auto: true, sessionID: 'ses_123', model: 'x/y' }),
    ['run', '--format', 'json', '--auto', '--session', 'ses_123', '-m', 'x/y', 'hello'],
  );
});

test('parseRunLine maps tool_use error to status event + error (permission denied)', () => {
  const denied = parseRunLine(
    JSON.stringify({
      type: 'tool_use',
      sessionID: 'ses_123',
      part: {
        type: 'tool',
        tool: 'bash',
        state: { status: 'error', error: 'Permission denied: shell' },
      },
    }),
  );
  assert.equal(denied.sessionID, 'ses_123');
  assert.equal(denied.tool, 'bash');
  assert.equal(denied.error, 'Permission denied: shell');
  assert.equal(denied.permission, null);
  assert.equal(denied.events.length, 1);
  assert.equal(denied.events[0].kind, 'status');
  assert.match(denied.events[0].text, /⚠ Permission denied: bash/);
});

test('parseRunLine maps tool_use interrupted error to permission status event', () => {
  const interrupted = parseRunLine(
    JSON.stringify({
      type: 'tool_use',
      sessionID: 'ses_123',
      part: {
        type: 'tool',
        tool: 'read',
        state: { status: 'error', error: 'Tool execution interrupted' },
      },
    }),
  );
  assert.equal(interrupted.error, 'Tool execution interrupted');
  assert.equal(interrupted.tool, 'read');
  assert.equal(interrupted.events[0].kind, 'status');
  assert.match(interrupted.events[0].text, /⚠ Permission interrupted: read/);
});

test('parseRunLine maps generic tool_use error to cross status event', () => {
  const failed = parseRunLine(
    JSON.stringify({
      type: 'tool_use',
      sessionID: 'ses_123',
      part: {
        type: 'tool',
        tool: 'bash',
        state: { status: 'error', error: 'cp: no such file' },
      },
    }),
  );
  assert.equal(failed.error, 'cp: no such file');
  assert.equal(failed.events[0].kind, 'status');
  assert.match(failed.events[0].text, /^✗ bash:/);
});

test('parseRunLine does not drop permission type', () => {
  const perm = parseRunLine(
    JSON.stringify({
      type: 'permission',
      sessionID: 'ses_123',
      part: { type: 'permission', action: 'external_directory', pattern: '/tmp/foo' },
    }),
  );
  assert.equal(perm.sessionID, 'ses_123');
  assert.equal(perm.type, 'permission');
  assert.deepEqual(perm.permission, { action: 'external_directory', pattern: '/tmp/foo' });
  assert.equal(perm.events.length, 1);
  assert.equal(perm.events[0].kind, 'status');
  assert.match(perm.events[0].text, /⚠ permission requested: external_directory/);
});
