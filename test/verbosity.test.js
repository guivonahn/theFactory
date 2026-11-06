import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  VERBOSITY_MARKER,
  VERBOSITY_ORDER,
  VERBOSITY_PROMPTS,
  applyVerbosityToAllAgents,
  stripVerbosity,
} from '../src/verbosity.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'thefactory-verbosity-'));
  const configFile = join(dir, 'opencode.json');
  const prompts = {
    orchestrator: 'ORCHESTRATOR BASE',
    developer: 'DEVELOPER BASE\nwith a second line',
  };
  writeFileSync(configFile, JSON.stringify({
    agents: {
      orchestrator: { model: 'opencode-go/glm-5.3', system: prompts.orchestrator },
      developer: { model: 'opencode-go/kimi-k3.1-pro', system: prompts.developer },
      explorer: { model: 'opencode-go/mimo-v2.6-flash' },
    },
  }));
  return { dir, configFile, prompts };
}

test('verbosity order, marker, and prompt copy are stable', () => {
  assert.deepEqual(VERBOSITY_ORDER, ['low', 'medium', 'high']);
  assert.equal(VERBOSITY_MARKER, '\n\n[theFactory verbosity]');
  assert.match(VERBOSITY_PROMPTS.low, /minimize tokens/i);
  assert.match(VERBOSITY_PROMPTS.medium, /concise/i);
  assert.match(VERBOSITY_PROMPTS.high, /evidence/i);
});

test('stripVerbosity restores the exact base prompt', () => {
  const base = 'BASE\nprompt';
  const applied = `${base}${VERBOSITY_MARKER}\nLOW`;
  assert.equal(stripVerbosity(applied), base);
  assert.equal(stripVerbosity(base), base);
  assert.equal(stripVerbosity(undefined), undefined);
});

test('applyVerbosityToAllAgents appends once and replaces on change', () => {
  const { dir, configFile, prompts } = fixture();
  try {
    const low = applyVerbosityToAllAgents('low', { configFile });
    assert.equal(low.ok, true);
    assert.equal(low.agents, 2, 'only agents with string system prompts are updated');
    assert.deepEqual(low.applied, [
      { agent: 'orchestrator', level: 'low' },
      { agent: 'developer', level: 'low' },
    ]);

    let saved = JSON.parse(readFileSync(configFile, 'utf8'));
    assert.equal(
      saved.agents.orchestrator.system,
      `${prompts.orchestrator}${VERBOSITY_MARKER}\n${VERBOSITY_PROMPTS.low}`,
    );
    assert.equal(
      saved.agents.developer.system,
      `${prompts.developer}${VERBOSITY_MARKER}\n${VERBOSITY_PROMPTS.low}`,
    );
    assert.equal(saved.agents.explorer.system, undefined);

    // Idempotent: applying the same level never stacks markers.
    applyVerbosityToAllAgents('low', { configFile });
    saved = JSON.parse(readFileSync(configFile, 'utf8'));
    assert.equal(saved.agents.orchestrator.system.split(VERBOSITY_MARKER).length, 2);

    // Switching levels replaces the block rather than appending a second one.
    const high = applyVerbosityToAllAgents('high', { configFile });
    assert.equal(high.ok, true);
    saved = JSON.parse(readFileSync(configFile, 'utf8'));
    assert.equal(saved.agents.orchestrator.system.split(VERBOSITY_MARKER).length, 2);
    assert.ok(saved.agents.orchestrator.system.endsWith(`\n${VERBOSITY_PROMPTS.high}`));

    // Null removes the block and restores the prompt byte-for-byte.
    const cleared = applyVerbosityToAllAgents(null, { configFile });
    assert.equal(cleared.ok, true);
    saved = JSON.parse(readFileSync(configFile, 'utf8'));
    assert.equal(saved.agents.orchestrator.system, prompts.orchestrator);
    assert.equal(saved.agents.developer.system, prompts.developer);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('applyVerbosityToAllAgents reports invalid input without writing', () => {
  const { dir, configFile } = fixture();
  try {
    const unknown = applyVerbosityToAllAgents('shouty', { configFile });
    assert.equal(unknown.ok, false);
    assert.equal(unknown.agents, 0);
    assert.match(unknown.error, /unknown verbosity: shouty/);

    rmSync(configFile);
    const missing = applyVerbosityToAllAgents('low', { configFile });
    assert.equal(missing.ok, false);
    assert.equal(missing.error, 'opencode.json not found');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
