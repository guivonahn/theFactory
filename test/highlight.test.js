import test from 'node:test';
import assert from 'node:assert/strict';
import { HIGHLIGHT_STYLES, highlightLine } from '../src/highlight.js';
import { AGENT_COLORS } from '../src/colors.js';

test('highlightLine preserves the exact input text', () => {
  const line = '✓ complete · orchestrator: edit src/app.js:12 · 12ms · https://example.com/a';
  const segments = highlightLine(line, '#ABCDEF');
  assert.equal(segments.map((segment) => segment.text).join(''), line);
});

test('highlightLine colors agent names and inline code', () => {
  const segments = highlightLine('developer ran `npm test` and it passed');
  const developer = segments.find((segment) => segment.text === 'developer');
  assert.equal(developer.style, AGENT_COLORS.developer);
  const code = segments.find((segment) => segment.text === '`npm test`');
  assert.equal(code.style, HIGHLIGHT_STYLES.code);
  const passed = segments.find((segment) => segment.text === 'passed');
  assert.equal(passed.style, HIGHLIGHT_STYLES.success);
});

test('highlightLine colors paths and numbers', () => {
  const segments = highlightLine('edit src/app.js:12 (3 tools, 42ms)');
  const path = segments.find((segment) => segment.text === 'src/app.js:12');
  assert.equal(path.style, HIGHLIGHT_STYLES.path);
  const number = segments.find((segment) => segment.text === '3');
  assert.equal(number.style, HIGHLIGHT_STYLES.number);
  const tools = segments.find((segment) => segment.text === 'tools');
  assert.equal(tools.style, HIGHLIGHT_STYLES.key);
});

test('highlightLine returns one base segment for plain text', () => {
  const base = '#123456';
  const segments = highlightLine('plain message', base);
  assert.equal(segments.length, 1);
  assert.equal(segments[0].text, 'plain message');
  assert.equal(segments[0].style, base);
});

test('highlightLine colors status glyphs and errors', () => {
  const segments = highlightLine('! failed to open /tmp/a.png');
  const bang = segments.find((segment) => segment.text === '!');
  assert.equal(bang.style, HIGHLIGHT_STYLES.error);
  const failed = segments.find((segment) => segment.text === 'failed');
  assert.equal(failed.style, HIGHLIGHT_STYLES.error);
  const path = segments.find((segment) => segment.text === '/tmp/a.png');
  assert.equal(path.style, HIGHLIGHT_STYLES.path);
});
