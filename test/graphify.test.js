import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureGraphify, graphifyPrompt, withGraphifyPrompt } from '../src/graphify.js';

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'thefactory-graphify-'));
}

test('graphifyPrompt names the graph and all three query commands', () => {
  const dir = join('/tmp', 'project');
  const prompt = graphifyPrompt(dir);
  assert.ok(prompt.includes(join(dir, 'graphify-out', 'graph.json')));
  assert.ok(prompt.includes('graphify query "..."'));
  assert.ok(prompt.includes('graphify path "A" "B"'));
  assert.ok(prompt.includes('graphify explain "X"'));
});

test('withGraphifyPrompt preserves the original task verbatim', () => {
  const task = 'Fix the tests\n  keep this indentation\nand Unicode: ✓';
  const prompted = withGraphifyPrompt(task, '/work/project');
  assert.equal(prompted, `${graphifyPrompt('/work/project')}\n\n${task}`);
  assert.ok(prompted.endsWith(task));
});

test('ensureGraphify uses an existing graph without spawning', () => {
  const dir = tempDir();
  try {
    const output = join(dir, 'graphify-out');
    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, 'graph.json'), '{}');
    const result = ensureGraphify(dir, { bin: join(dir, 'definitely-missing-graphify') });
    assert.equal(result.ok, true);
    assert.equal(result.built, false);
    assert.equal(result.graphPath, join(output, 'graph.json'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureGraphify builds with the configured executable', () => {
  const dir = tempDir();
  try {
    const bin = join(dir, 'fake-graphify');
    writeFileSync(bin, '#!/bin/sh\nset -eu\nmkdir -p "$2/graphify-out"\nprintf \'{}\' > "$2/graphify-out/graph.json"\n');
    chmodSync(bin, 0o700);
    const result = ensureGraphify(dir, { bin, timeout: 5000 });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.built, true);
    assert.equal(result.error, null);
    assert.equal(result.graphPath, join(dir, 'graphify-out', 'graph.json'));
    assert.equal(existsSync(result.graphPath), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureGraphify reports a missing binary without throwing', () => {
  const dir = tempDir();
  try {
    let result;
    assert.doesNotThrow(() => {
      result = ensureGraphify(dir, { bin: join(dir, 'missing-graphify'), timeout: 1000 });
    });
    assert.equal(result.ok, false);
    assert.equal(typeof result.error, 'string');
    assert.ok(result.error.length > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
