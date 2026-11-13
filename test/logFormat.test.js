import test from 'node:test';
import assert from 'node:assert/strict';
import { App } from '../src/app.js';
import { displayWidth } from '../src/canvas.js';
import { formatLogEntries, logMatches, toolLogEntry, wrapLogSegments } from '../src/logFormat.js';
import { highlightCode } from '../src/highlight.js';
import { parseRunLine } from '../src/run.js';
import { convertRow } from '../src/live.js';

test('code highlighting and wrapping preserve indentation, Unicode, and syntax exactly', () => {
  const code = '    const result = await fetch("/api/界"); // keep spacing';
  const segments = highlightCode(code, 'typescript');
  assert.equal(segments.map((s) => s.text).join(''), code);
  assert.ok(new Set(segments.map((s) => s.style)).size >= 4);
  const rows = wrapLogSegments(segments, 16, false);
  assert.equal(rows.map((row) => row.text).join(''), code);
  assert.ok(rows.every((row) => displayWidth(row.text) <= 16));
  assert.ok(rows[0].text.startsWith('    const'));
  assert.notEqual(highlightCode('+ added', 'diff')[0].style, highlightCode('- removed', 'diff')[0].style);
});

test('CLI and database responses retain Markdown and code instead of summaries', () => {
  const response = '# Result\n\n```typescript\nfunction hello() {\n  return "hello";\n}\n```\n';
  const parsed = parseRunLine(JSON.stringify({ type: 'text', timestamp: 1000, sessionID: 'session_a', part: { id: 'part_a', text: response } }));
  assert.equal(parsed.text, response);
  assert.equal(parsed.logEntry.text, response);
  const events = convertRow({ id: 'row_a', type: 'assistant', session_id: 'session_a', time_created: 1000, data: JSON.stringify({ content: [{ type: 'text', text: response }] }) }, { isRoot: false, agentKey: 'developer' });
  const app = new App({ width: 100, height: 32, color: false });
  events.forEach((event) => app.applyEvent(event));
  app.openLog('developer');
  assert.equal(app._logEntries()[0].text, response);
  const snapshot = app.snapshot();
  assert.match(snapshot, /```typescript/);
  assert.match(snapshot, /  return "hello";/);
  assert.match(snapshot, /RESPONSE/);
});

test('tool logs expose status, timing, formatted input, output, and actual errors', () => {
  const part = { id: 'part_tool', type: 'tool', tool: 'shell', state: { status: 'completed', input: { command: 'npm test\nnode --version' }, output: '12 passed\n0 failed', time: { start: 100, end: 350 } } };
  const entry = toolLogEntry(part);
  assert.equal(entry.durationMs, 250);
  assert.match(entry.text, /```sh\nnpm test\nnode --version/);
  assert.match(entry.text, /Output\n```text\n12 passed\n0 failed/);
  assert.equal(logMatches(entry, 'errors'), false, 'words inside successful output are not failures');
  const rows = formatLogEntries([entry], 60);
  assert.match(rows[0].text, /TOOL · shell · completed · 250ms/);
  const failed = toolLogEntry({ ...part, state: { ...part.state, status: 'error', error: 'Permission denied' } });
  assert.equal(logMatches(failed, 'errors'), true);
  assert.equal(logMatches({ kind: 'message', text: 'Here is how to handle an error' }, 'errors'), false);
  const large = toolLogEntry({ tool: 'read', state: { output: 'x'.repeat(33000) } });
  assert.match(large.text, /truncated at 32,000/);
});

test('orchestrator history outlives the small feed, filters work, and tool updates deduplicate', () => {
  const app = new App({ width: 100, height: 32, color: false });
  for (let i = 0; i < 40; i += 1) app.addLog(`event ${i}`);
  assert.equal(app.centerLog.length, 20);
  app.openLog('orchestrator');
  assert.equal(app._logEntries().length, 40);
  assert.equal(app._logEntries()[0].text, 'event 0');
  app.recordAgentLog('developer', { id: 'tool_1', kind: 'tool', tool: 'read', text: 'running', status: 'running' });
  app.recordAgentLog('developer', { id: 'tool_1', kind: 'tool', tool: 'read', text: 'file content', status: 'completed' });
  app.recordAgentLog('developer', { kind: 'message', text: 'result' });
  app.recordAgentLog('developer', { kind: 'error', text: '429 quota exhausted' });
  app.openLog('developer');
  assert.equal(app._logEntries().length, 3);
  app.cycleLogFilter();
  assert.deepEqual(app._logEntries().map((entry) => entry.text), ['result']);
  app.cycleLogFilter();
  assert.deepEqual(app._logEntries().map((entry) => entry.text), ['file content']);
  app.cycleLogFilter();
  assert.deepEqual(app._logEntries().map((entry) => entry.text), ['429 quota exhausted']);
});

test('reading older rows stays anchored as live events arrive; follow resumes explicitly', () => {
  const app = new App({ width: 80, height: 24, color: false });
  for (let i = 0; i < 30; i += 1) app.addLog(`event ${i}`);
  app.openLog('orchestrator');
  app._logLines(5);
  app.scrollLog(-12);
  const reading = app._logLines(5);
  app.addLog('new live entry');
  assert.deepEqual(app._logLines(5), reading);
  app.jumpLog(true);
  assert.match(app._logLines(5).join('\n'), /new live entry/);
  app.toggleLogFollow();
  const paused = app._logLines(5);
  app.addLog('another live entry');
  assert.deepEqual(app._logLines(5), paused);
  app.toggleLogFollow();
  assert.match(app._logLines(5).join('\n'), /another live entry/);
});

test('log metadata and controls fit minimum and large terminals without clipping', () => {
  for (const [width, height] of [[60, 24], [100, 32], [140, 45]]) {
    const app = new App({ width, height, color: false });
    app.setAgentRuntime('developer', { model: 'coarena-2/claude-fable-5-2', sessionID: 'session_developer' });
    app.recordAgentLog('developer', { kind: 'message', text: 'Readable logs' });
    app.openLog('developer');
    const snap = app.snapshot();
    assert.match(snap, /coarena-2\/claude-fable-5-2/);
    assert.match(snap, /session_developer/);
    assert.match(snap, /Readable logs/);
    assert.match(snap, /f filter/);
    assert.ok(snap.split('\n').every((line) => displayWidth(line) <= width));
  }
});
