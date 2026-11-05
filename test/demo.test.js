import test from 'node:test';
import assert from 'node:assert/strict';
import { AGENT_ORDER } from '../src/agents.js';
import { demoEvents } from '../src/demo.js';

test('demo timeline is sorted and only targets known agents', () => {
  const timeline = demoEvents();
  assert.ok(timeline.length >= 30 && timeline.length <= 50);
  for (let index = 1; index < timeline.length; index += 1) {
    assert.ok(timeline[index].at >= timeline[index - 1].at);
  }

  const known = new Set([...AGENT_ORDER, 'orchestrator']);
  for (const { event } of timeline) {
    if (event.kind !== 'msg') continue;
    if (event.from) assert.ok(known.has(event.from), `unknown from ${event.from}`);
    if (event.to) assert.ok(known.has(event.to), `unknown to ${event.to}`);
    assert.ok(event.dir === 'in' || event.dir === 'out');
  }
  assert.ok(timeline.some(({ event }) => event.dir === 'in'));
  assert.ok(timeline.some(({ event }) => event.dir === 'out'));
});
