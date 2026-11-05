import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  clearPersistedSession,
  loadPersistedSession,
  persistedSessionPath,
  savePersistedSession,
} from '../src/sessionState.js';

function tempStateHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'factory-session-state-'));
}

test('sessionState round-trips the persisted session id', () => {
  const home = tempStateHome();
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = home;
  try {
    assert.equal(persistedSessionPath(), path.join(home, 'thefactory', 'session.json'));
    assert.equal(loadPersistedSession({ dir: process.cwd() }), null);

    savePersistedSession({ sessionID: 'ses_roundtrip', dir: process.cwd() });
    const loaded = loadPersistedSession({ dir: process.cwd() });
    assert.equal(loaded.sessionID, 'ses_roundtrip');
    assert.equal(loaded.dir, process.cwd());
    assert.ok(loaded.updatedAt);

    clearPersistedSession();
    assert.equal(loadPersistedSession({ dir: process.cwd() }), null);
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('sessionState ignores a persisted id from another directory', () => {
  const home = tempStateHome();
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = home;
  try {
    savePersistedSession({ sessionID: 'ses_wrongdir', dir: '/tmp/factory-other-dir' });
    assert.equal(loadPersistedSession({ dir: process.cwd() }), null);
    assert.equal(loadPersistedSession({ dir: '/tmp/factory-other-dir' }).sessionID, 'ses_wrongdir');
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
