import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchGoUsage,
  formatReset,
  readOpencodeAccessToken,
  GO_USAGE_URL,
} from '../src/goUsage.js';

test('formatReset converts ISO reset timestamps to compact durations', () => {
  const now = Date.now();
  assert.equal(formatReset(new Date(now + 90000).toISOString(), now), '2m');
  assert.equal(formatReset(new Date(now + 3000000).toISOString(), now), '50m');
  assert.equal(formatReset(new Date(now + 4 * 3600000 + 7 * 60000).toISOString(), now), '4h7m');
  assert.equal(formatReset(new Date(now - 1000).toISOString(), now), 'now');
  assert.equal(formatReset('', now), '');
  assert.equal(formatReset('not-a-date', now), '');
  assert.equal(formatReset(null, now), '');
  assert.equal(formatReset(new Date(now + 3600000).toISOString(), NaN), '');
});

test('fetchGoUsage normalizes the verified Go usage JSON shape', async () => {
  const payload = {
    usage: {
      rolling: { status: 'ok', percent: 80, resetsAt: '2026-11-06T17:12:36.000Z' },
      weekly: { status: 'ok', percent: 72, resetsAt: '2026-11-09T00:00:00.000Z' },
      monthly: { status: 'ok', percent: 36, resetsAt: '2026-12-06T00:12:59.000Z' },
    },
  };
  let captured;
  const usage = await fetchGoUsage({
    token: 'st_abc123',
    fetchImpl: async (url, opts) => {
      captured = { url, auth: opts?.headers?.Authorization };
      return {
        ok: true,
        json: async () => payload,
      };
    },
  });
  assert.equal(captured.url, GO_USAGE_URL);
  assert.equal(captured.auth, 'Bearer st_abc123');
  assert.equal(usage.rolling.percent, 80);
  assert.equal(usage.rolling.status, 'ok');
  assert.equal(usage.rolling.resetsAt, '2026-11-06T17:12:36.000Z');
  assert.equal(usage.weekly.percent, 72);
  assert.equal(usage.monthly.percent, 36);
});

test('fetchGoUsage returns null on HTTP error', async () => {
  const usage = await fetchGoUsage({
    token: 'st_abc123',
    fetchImpl: async () => ({ ok: false, status: 401 }),
  });
  assert.equal(usage, null);
});

test('fetchGoUsage returns null on bad JSON', async () => {
  const usage = await fetchGoUsage({
    token: 'st_abc123',
    fetchImpl: async () => ({ ok: true, json: async () => { throw new Error('bad json'); } }),
  });
  assert.equal(usage, null);
});

test('fetchGoUsage returns null on missing rolling window', async () => {
  const usage = await fetchGoUsage({
    token: 'st_abc123',
    fetchImpl: async () => ({ ok: true, json: async () => ({ usage: {} }) }),
  });
  assert.equal(usage, null);
});

test('fetchGoUsage returns null on missing token', async () => {
  const usage = await fetchGoUsage({ token: '' });
  assert.equal(usage, null);
  const usage2 = await fetchGoUsage({});
  assert.equal(usage2, null);
});

test('readOpencodeAccessToken never throws on missing/unreadable db', () => {
  // Missing path -> null (never throws).
  assert.equal(readOpencodeAccessToken('/definitely/does/not/exist.db'), null);
  // Default path may exist on dev machines; assert it never throws and returns
  // null or a token string.
  const result = readOpencodeAccessToken();
  assert.ok(result === null || typeof result === 'string');
});
