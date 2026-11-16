import test from 'node:test';
import assert from 'node:assert/strict';
import { parseModelCatalog, readModelCatalog } from '../src/modelCatalog.js';
import { parseArgs } from '../src/main.js';

test('catalog keeps every provider, removes decorations and deduplicates identifiers', () => {
  assert.deepEqual(parseModelCatalog('\x1b[32mopenai/gpt-test\x1b[0m\nanthropic/claude-test\nOC-NOLIMIT/test\nopencode/free\nopenai/gpt-test\nSome status message\n'),
    ['openai/gpt-test', 'anthropic/claude-test', 'OC-NOLIMIT/test', 'opencode/free']);
  assert.equal(parseArgs(['--model-catalog']).modelCatalog, true);
});

test('catalog adds configured aliases without leaking keys or restricting the provider list', () => {
  const env = { COARENA_API_KEY_1: 'private-fixture-1', COARENA_API_KEY_2: 'private-fixture-2', FACTORY_OPENCODE: '/fixture/opencode' };
  const result = readModelCatalog({ env, execute: (bin, args, options) => {
    assert.equal(bin, '/fixture/opencode'); assert.deepEqual(args, ['models']);
    assert.equal(options.timeout, 15000);
    return 'openai/gpt-test\nopencode-go/test\ncoarena-1/claude-opus-5-5\n';
  } });
  assert.equal(result.error, null);
  assert.equal(result.models.length, 7);
  assert.ok(result.models.includes('openai/gpt-test'));
  assert.ok(result.models.includes('coarena/claude-fable-5-2'));
  for (const model of ['gpt-6-luna', 'gemini-3-8-flash', 'deepseek-v4-1-flash-1017']) assert.ok(result.models.includes(`coarena/${model}`));
  assert.ok(result.models.every((model) => !/^coarena-\d+\//.test(model)));
  assert.equal(JSON.stringify(result).includes('private-fixture'), false);
});

test('catalog failures are explicit and never print raw errors or pretend a preset is the full list', () => {
  const result = readModelCatalog({ env: {}, execute: () => { throw new Error('secret-fixture'); } });
  assert.deepEqual(result.models, []);
  assert.match(result.error, /Could not load/);
  assert.equal(JSON.stringify(result).includes('secret-fixture'), false);
  assert.match(readModelCatalog({ env: {}, execute: () => '' }).error, /returned no models/);
});
