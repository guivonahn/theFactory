import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { App } from '../src/app.js';
import { displayWidth } from '../src/canvas.js';
import { createSessionPicker, sessionPickerKey, sessionPickerRows } from '../src/sessionPicker.js';
import { fetchSessionGroups, listSessionGroups, resolveSessionGroup, registerSession, loadSessionGroups, sessionGroupContext, sessionGroupHistory } from '../src/sessionGroups.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'factory-groups-')), path = join(dir, 'sessions.db'), registry = join(dir, 'groups.json');
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE session_v2(id TEXT PRIMARY KEY,parent_id TEXT,slug TEXT,title TEXT,agent TEXT,directory TEXT,time_created INTEGER);
    CREATE TABLE session_message(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,seq INTEGER,time_created INTEGER,data TEXT);`);
  let count = 0;
  const session = (id, parent, role, title, directory = dir, at = 1) => db.prepare('INSERT INTO session_v2 VALUES(?,?,?,?,?,?,?)').run(id, parent, `slug-${id}`, title, role, directory, at);
  const message = (id, data, type = 'assistant', at = 10) => {
    count++; db.prepare('INSERT INTO session_message VALUES(?,?,?,?,?,?)').run(`m${count}`, id, type, count, at, JSON.stringify(data));
  };
  session('root-A', null, 'orchestrator', 'BioCrowds simulation');
  session('native-child', 'root-A', 'developer', 'Implement raylib renderer');
  session('native-grandchild', 'native-child', 'tester', 'Verify executable');
  session('worker-root', null, 'developer', 'Implement core');
  session('worker-child', 'worker-root', 'explorer', 'Inspect marker sampling');
  session('review-root', null, 'orchestrator', 'Review acceptance');
  session('summary-root', null, 'orchestrator', 'Final summary');
  session('root-B', null, 'orchestrator', 'Other conversation', join(dir, 'other'), 20);
  message('native-child', { agent: 'developer', content: [{ type: 'text', text: 'Implemented src/Renderer.cpp and built the visualizer.' }], finish: 'stop' }, 'assistant', 30);
  message('native-child', { outcome: 'completed' }, 'idle', 31);
  message('native-grandchild', { outcome: 'failed', error: { message: 'Missing display device for GUI check' } }, 'idle', 32);
  message('worker-root', { agent: 'developer', content: [{ type: 'text', text: 'Implemented src/Simulation.cpp.' }], finish: 'stop' }, 'assistant', 33);
  const recorded = [{ id: 'run-A', rootSessionID: 'root-A', dir, title: 'Build BioCrowds and executable', sessions: [
    { id: 'root-A', role: 'orchestrator', kind: 'planner' }, { id: 'worker-root', role: 'developer', kind: 'worker' },
    { id: 'review-root', role: 'orchestrator', kind: 'acceptance' }, { id: 'summary-root', role: 'orchestrator', kind: 'overview' },
  ] }];
  return { dir, path, registry, db, recorded, session, message, close() { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('native descendants and explicit managed-run links form one conversation without merging unrelated roots', () => {
  const f = fixture();
  try {
    const groups = fetchSessionGroups(f.db, { registry: f.recorded });
    assert.equal(groups.length, 2);
    const group = groups.find((g) => g.id === 'root-A');
    assert.equal(group.childCount, 6);
    assert.equal(group.updatedAt, 33);
    assert.equal(group.title, 'Build BioCrowds and executable');
    assert.ok(group.members.some((m) => m.id === 'worker-child'));
    assert.equal(group.members.find((m) => m.id === 'native-grandchild').parentID, 'native-child');
    assert.equal(group.blockedCount, 1);
    assert.equal(fetchSessionGroups(f.db, { registry: f.recorded, dir: f.dir }).length, 1);
    assert.equal(fetchSessionGroups(f.db, { registry: [] }).length, 5, 'unrecorded roots remain separate');
  } finally { f.close(); }
});

test('child IDs, child slugs, parent IDs and stable displayed numbers all resolve to the parent conversation', () => {
  const f = fixture();
  try {
    const groups = fetchSessionGroups(f.db, { registry: f.recorded });
    for (const id of ['native-grandchild', 'worker-root', 'worker-child', 'slug-native-child', 'root-A']) assert.equal(resolveSessionGroup(id, { groups }).id, 'root-A');
    assert.equal(resolveSessionGroup('#2', { groups: [...groups].reverse() }).id, groups[0].id);
    assert.throws(() => resolveSessionGroup('root-', { groups }), /ambiguous/);
    for (const id of ['missing', '#0', '#99']) assert.throws(() => resolveSessionGroup(id, { groups }), /not found|outside/);
  } finally { f.close(); }
});

test('registry survives restarts, deduplicates session membership, and ignores corrupt entries', () => {
  const f = fixture();
  try {
    for (const id of ['worker-root', 'review-root', 'worker-root']) registerSession({ groupID: 'run-A', rootSessionID: 'root-A', sessionID: id, dir: f.dir, title: 'Build project', role: 'developer' }, f.registry);
    const loaded = loadSessionGroups(f.registry);
    assert.equal(loaded.length, 1); assert.equal(loaded[0].sessions.length, 2);
    assert.equal(fetchSessionGroups(f.db, { registry: loaded }).find((g) => g.id === 'root-A').childCount, 5);
    if (process.platform !== 'win32') assert.equal(statSync(f.registry).mode & 0o777, 0o600);
    writeFileSync(f.registry, '[null,{}, {"rootSessionID":"root-A","sessions":false}]');
    assert.deepEqual(loadSessionGroups(f.registry), []);
  } finally { f.close(); }
});

test('resume context and restored logs include child outcomes and preserve their authors', () => {
  const f = fixture(), previous = process.env.OPENCODE_DB;
  process.env.OPENCODE_DB = f.path;
  try {
    const group = fetchSessionGroups(f.db, { registry: f.recorded }).find((g) => g.id === 'root-A');
    const context = sessionGroupContext(group);
    assert.match(context, /Renderer.cpp/); assert.match(context, /Simulation.cpp/); assert.match(context, /Missing display device/);
    assert.match(context, /recorded outcomes/);
    const app = new App({ color: false });
    app.recordAgentLog('developer', { text: 'UNRELATED OLD CONVERSATION' });
    app.selectConversation(group);
    sessionGroupHistory(group).forEach((e) => app.applyEvent(e));
    assert.equal(app.sessionID, 'root-A');
    assert.ok(app.agents.get('developer').history.some((e) => e.text.includes('Renderer.cpp')));
    assert.equal(app.agents.get('developer').history.some((e) => e.text.includes('UNRELATED')), false);
    assert.equal(app.orchestratorHistory.some((e) => e.text.includes('Renderer.cpp')), false);
  } finally { if (previous === undefined) delete process.env.OPENCODE_DB; else process.env.OPENCODE_DB = previous; f.close(); }
});

test('saved parallel state groups roots only when its real parent was recorded', () => {
  const f = fixture();
  try {
    const state = { rootSessionID: 'root-A', runId: 'legacy', objective: 'Earlier run', workers: [{ sessionId: 'worker-root', role: 'developer' }] };
    assert.equal(fetchSessionGroups(f.db, { registry: [], parallelState: state }).find((g) => g.id === 'root-A').childCount, 4);
    delete state.rootSessionID;
    assert.equal(fetchSessionGroups(f.db, { registry: [], parallelState: state }).find((g) => g.id === 'root-A').childCount, 2);
  } finally { f.close(); }
});

test('keyboard search, expansion and selection keep descendant rows attached to the parent', () => {
  const f = fixture();
  try {
    const groups = fetchSessionGroups(f.db, { registry: f.recorded }), picker = createSessionPicker(groups);
    assert.equal(sessionPickerRows(picker).length, 2);
    sessionPickerKey(picker, '\x1b[C');
    sessionPickerKey(picker, '\x1b[B');
    assert.ok(sessionPickerRows(picker)[picker.selected].member);
    assert.equal(sessionPickerKey(picker, '\r').group.id, 'root-A');
    sessionPickerKey(picker, '\x1b[D');
    assert.equal(picker.selected, 0);
    for (const char of 'raylib renderer') sessionPickerKey(picker, char);
    assert.equal(picker.query, 'raylib renderer');
    assert.ok(sessionPickerRows(picker).every((row) => row.group.id === 'root-A'));
    assert.equal(sessionPickerKey(picker, '\t').allProjects, true);
    assert.equal(sessionPickerKey(picker, '\x1b').action, 'close');
    assert.equal(sessionPickerKey(picker, '\u0003').action, 'quit');
  } finally { f.close(); }
});

test('the grouped picker fits minimum and larger terminals, keeps selected rows visible and handles empty/error states', () => {
  const f = fixture();
  try {
    const groups = fetchSessionGroups(f.db, { registry: f.recorded });
    for (const [width, height] of [[60, 24], [100, 40], [140, 45]]) {
      const app = new App({ width, height, color: false, reducedMotion: true });
      app.openSessions(groups, { currentID: 'root-A' });
      app.handleSessionPickerKey('\x1b[C');
      app.handleSessionPickerKey('\x1b[6~');
      let text = app.snapshot();
      assert.match(text, /SESSIONS/); assert.match(text, /Enter resume/); assert.match(text, /Resume main/);
      assert.ok(text.split('\n').every((line) => displayWidth(line) <= width));
      assert.doesNotMatch(text, /\u0000/);
      writeFileSync(join('/tmp', `thefactory-sessions-${width}.txt`), text);
      app.openSessions([]);
      assert.match(app.snapshot(), /No conversations found/);
      app.sessionPicker.error = 'Cannot load sessions';
      assert.match(app.snapshot(), /Cannot load sessions/);
    }
  } finally { f.close(); }
});

test('listing and resolution use the configured read-only database without touching other projects', () => {
  const f = fixture(), previousDB = process.env.OPENCODE_DB, previousState = process.env.XDG_STATE_HOME;
  process.env.OPENCODE_DB = f.path; process.env.XDG_STATE_HOME = join(f.dir, 'state');
  try {
    assert.equal(listSessionGroups({ dir: f.dir }).length, 4);
    assert.equal(resolveSessionGroup('native-child').id, 'root-A');
    assert.throws(() => resolveSessionGroup('nonexistent-session'), /not found/);
    assert.ok(readFileSync(f.path).length > 0);
  } finally {
    if (previousDB === undefined) delete process.env.OPENCODE_DB; else process.env.OPENCODE_DB = previousDB;
    if (previousState === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = previousState;
    f.close();
  }
});
