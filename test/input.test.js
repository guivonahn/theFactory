import test from 'node:test';
import assert from 'node:assert/strict';
import { LineInput } from '../src/input.js';
import { argsForRun } from '../src/run.js';

const START = '\x1b[200~';
const END = '\x1b[201~';

function paste(label, lines) {
  const input = new LineInput();
  // Split into 3 chunks to prove split-marker + split-body handling.
  const mid = Math.floor(lines.length / 3);
  const body = lines.join('\n');
  const c1 = START + body.slice(0, mid);
  const c2 = body.slice(mid, mid * 2);
  const c3 = body.slice(mid * 2) + END;
  for (const chunk of [c1, c2, c3]) input.handle(chunk);
  return input;
}

function byteEqual(input, expected) {
  assert.equal(input.value, expected);
  assert.equal(Buffer.from(input.value, 'utf8').length, Buffer.from(expected, 'utf8').length);
}

test('bracketed paste preserves 1,000-line paste byte-for-byte, no submit', () => {
  const lines = Array.from({ length: 1000 }, (_, i) => `line ${i}  indented\t✓ é ${i % 10}`);
  const input = paste('1k', lines);
  byteEqual(input, lines.join('\n'));
  assert.equal(input.lines().length, 1000);
  // No submit action fired during paste (only pasted/changed).
});

test('bracketed paste preserves 10,000-line paste byte-for-byte', () => {
  const lines = Array.from({ length: 10000 }, (_, i) => `  x${i} — unicode ✓🚀`);
  const input = paste('10k', lines);
  byteEqual(input, lines.join('\n'));
  assert.equal(input.lines().length, 10000);
});

test('bracketed paste preserves 50,000-line paste without freezing', { timeout: 15000 }, () => {
  const lines = Array.from({ length: 50000 }, (_, i) => `row ${i}\tvalue=${i}`);
  const input = paste('50k', lines);
  byteEqual(input, lines.join('\n'));
  assert.equal(input.lines().length, 50000);
  // Cursor at end, viewport sane.
  assert.equal(input.cursorLine(), 49999);
  const vp = input.viewport(1);
  assert.equal(vp.lines.length, 1);
});

test('paste newlines do not submit; only explicit Enter submits full prompt', () => {
  const input = new LineInput();
  const actions = input.handle(START + 'a\nb\nc' + END);
  assert.ok(!actions.some((a) => a.type === 'submit'));
  const submit = input.handle('\r');
  const done = submit.find((a) => a.type === 'submit');
  assert.equal(done.value, 'a\nb\nc');
  // Full prompt reaches OpenCode argv verbatim (opencode run takes one argv slot).
  assert.deepEqual(argsForRun({ task: done.value }), ['run', '--format', 'json', 'a\nb\nc']);
});

test('existing keys still work: backspace, q-quit, esc-abort, ctrl-c', () => {
  const input = new LineInput('ab');
  input.handle('\u007f');
  assert.equal(input.value, 'a');
  const q = new LineInput('');
  assert.ok(q.handle('q').some((a) => a.type === 'quit'));
  const esc = new LineInput('');
  assert.ok(esc.handle('\x1b').some((a) => a.type === 'abort'));
  const cc = new LineInput('x');
  assert.ok(cc.handle('\u0003').some((a) => a.type === 'quit'));
});

test('paste label matches opencode style', () => {
  const input = new LineInput();
  assert.equal(input.pasteLabel('a\nb\nc'), '[pasted 3 lines]');
  assert.equal(input.pasteLabel('only'), '[pasted 1 line]');
});
