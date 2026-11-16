import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { App } from '../src/app.js';
import { LiveSource, convertRow } from '../src/live.js';
import { createNativeSessionMonitor } from '../src/nativeSessions.js';
import { launchTaskWithRecovery } from '../src/run.js';
import { applySubagentEvent } from '../src/runEvents.js';

const quota = 'You have reached your specified API usage limits.';
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'factory-native-'));
  const path = join(dir, 'opencode.db');
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE session_v2 (id TEXT PRIMARY KEY,parent_id TEXT,agent TEXT,title TEXT,directory TEXT,time_created INTEGER);
    CREATE TABLE session_message (id TEXT PRIMARY KEY,session_id TEXT,type TEXT,seq INTEGER,time_created INTEGER,data TEXT);`);
  const session = (id, parent = 'root', agent = 'developer') => db.prepare('INSERT INTO session_v2 VALUES (?,?,?,?,?,?)').run(id, parent, agent, `Task ${id}`, dir, 1);
  const message = (sid, seq, type, data, at = seq) => {
    const row = { id: `${sid}-${seq}`, session_id: sid, type, seq, time_created: at, data: JSON.stringify(data) };
    db.prepare('INSERT INTO session_message VALUES (?,?,?,?,?,?)').run(row.id, sid, type, seq, at, row.data);
    return row;
  };
  session('root', null, 'orchestrator');
  return { dir, path, db, session, message, close() { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}
const meta = { isRoot: false, agentKey: 'developer' };

test('content-free assistant errors and failed idle outcomes settle the real developer and retain the cause', () => {
  const f = fixture();
  try {
    f.session('child');
    const rows = [f.message('child', 1, 'user', { text: 'Implement assigned files' }),
      f.message('child', 2, 'assistant', { agent: 'developer', finish: 'error', content: [], error: { message: quota, status: 400 } }),
      f.message('child', 3, 'idle', { outcome: 'failed', error: { message: quota, status: 400 } })];
    const cues = [], app = new App({ onSound: (cue) => cues.push(cue) });
    for (const row of rows) for (const event of convertRow(row, meta)) app.applyEvent(event);
    assert.equal(app.agents.get('developer').status, 'idle');
    assert.ok(app.agents.get('developer').history.some((entry) => entry.text.includes(quota)));
    assert.equal(cues.includes('error'), false);
    assert.equal(app.orchestratorHistory.some((entry) => entry.text.includes(quota)), false);
  } finally { f.close(); }
});

test('one failed child cannot hide another working child of the same role', () => {
  const app = new App({ color: false });
  const row = (sid, at, type, data) => ({ id: `${sid}-${at}`, session_id: sid, time_created: at, type, data: JSON.stringify(data) });
  const events = [row('one', 1, 'user', { text: 'First task' }), row('two', 2, 'user', { text: 'Second task' }),
    row('one', 3, 'idle', { outcome: 'failed', error: { message: quota } })];
  for (const r of events) for (const e of convertRow(r, meta)) app.applyEvent(e);
  assert.equal(app.agents.get('developer').status, 'working');
  for (const e of convertRow(row('two', 4, 'idle', { outcome: 'completed' }), meta)) app.applyEvent(e);
  assert.equal(app.agents.get('developer').status, 'idle');
});

test('older DB failure replay does not override newer child recovery activity', () => {
  const app = new App({ color: false });
  app.applyEvent({ kind: 'status', from: 'developer', state: 'working', sessionID: 'child', logEntry: { timestamp: 100, text: 'Recovering' } });
  const row = { id: 'old', session_id: 'child', type: 'idle', time_created: 50, data: JSON.stringify({ outcome: 'failed', error: { message: quota } }) };
  for (const e of convertRow(row, meta)) app.applyEvent(e);
  assert.equal(app.agents.get('developer').status, 'working');
});

test('root-session messages honor the agent recorded by OpenCode instead of assigning every write to orchestrator', () => {
  const events = convertRow({ id: 'write', session_id: 'root', type: 'assistant', data: JSON.stringify({ agent: 'developer', content: [
    { type: 'tool', name: 'write', state: { status: 'completed', input: { filePath: 'src/feature.cpp' } } },
  ] }) }, { isRoot: true, agentKey: 'orchestrator' });
  assert.equal(events[0].from, 'developer');
  const app = new App({ color: false });
  events.forEach((e) => app.applyEvent(e));
  assert.ok(app.agents.get('developer').history.some((e) => e.tool === 'write'));
});

test('live polling and backfill include idle outcomes and grandchildren', () => {
  const f = fixture(), previous = process.env.OPENCODE_DB;
  process.env.OPENCODE_DB = f.path;
  let source;
  try {
    f.session('child'); f.session('grandchild', 'child', 'tester');
    f.message('child', 1, 'user', { text: 'Do work' });
    f.message('grandchild', 1, 'user', { text: 'Verify work' });
    source = new LiveSource({ session: 'root' }).open();
    const app = new App({ color: false });
    source.loadBackfill().forEach((e) => app.applyEvent(e));
    assert.equal(app.agents.get('developer').status, 'working');
    assert.equal(app.agents.get('tester').status, 'working');
    f.message('child', 2, 'idle', { outcome: 'failed', error: { message: quota } });
    f.message('grandchild', 2, 'idle', { outcome: 'completed' });
    source.poll().forEach((e) => app.applyEvent(e));
    assert.equal(app.agents.get('developer').status, 'idle');
    assert.equal(app.agents.get('tester').status, 'done');
    assert.ok(source.loadBackfill().some((e) => e.text.includes(quota)));
  } finally { source?.close(); if (previous === undefined) delete process.env.OPENCODE_DB; else process.env.OPENCODE_DB = previous; f.close(); }
});

test('native monitor ignores historical failures, finds fresh descendants, and detects unfinished siblings', () => {
  const f = fixture(), monitor = createNativeSessionMonitor({ path: f.path, since: 10 });
  try {
    f.session('old'); f.message('old', 1, 'idle', { outcome: 'failed', error: { message: quota } }, 5);
    f.session('child'); f.message('child', 1, 'user', { text: 'Original assignment' }, 11);
    f.session('grandchild', 'child');
    f.message('grandchild', 1, 'user', { text: 'Nested assignment' }, 12);
    f.message('grandchild', 2, 'assistant', { model: { providerID: 'fixture', modelID: 'limited' }, finish: 'error', error: { message: quota } }, 13);
    f.message('grandchild', 3, 'idle', { outcome: 'failed', error: { message: quota } }, 14);
    const snapshot = monitor.scan('root');
    assert.deepEqual(snapshot.active, ['child']);
    assert.equal(snapshot.failures.length, 1);
    assert.equal(snapshot.failures[0].id, 'grandchild');
    assert.equal(snapshot.failures[0].model, 'fixture/limited');
    assert.equal(snapshot.failures[0].prompt, 'Nested assignment');
  } finally { monitor.close(); f.close(); }
});

test('supervised child events populate only their own log and runtime', () => {
  const app = new App({ color: false }); app.startRun({ sessionID: 'root' });
  assert.equal(applySubagentEvent(app, { isSubagent: true, agent: 'developer', sessionID: 'child', text: 'Implemented src/code.cpp',
    logEntry: { kind: 'message', text: 'Implemented src/code.cpp', sessionID: 'child', model: 'fixture/backup' },
    events: [{ kind: 'status', text: 'writing source', state: 'working' }] }), true);
  assert.equal(app.run.sessionID, 'root');
  assert.equal(app.agentRuntime.get('developer').sessionID, 'child');
  assert.ok(app.agents.get('developer').history.some((e) => e.text.includes('code.cpp')));
  assert.equal(app.orchestratorHistory.some((e) => e.text.includes('code.cpp')), false);
});

test('native child quota recovery stops the parent, resumes the original child on a fallback, then resumes the parent with its handoff', { skip: process.platform === 'win32', timeout: 15000 }, async () => {
  const f = fixture();
  try {
    const bin = join(f.dir, 'opencode'), calls = join(f.dir, 'calls.jsonl');
    writeFileSync(bin, `#!/usr/bin/env node
const fs=require('node:fs'), {DatabaseSync}=require('node:sqlite');
const a=process.argv.slice(2), model=a[a.indexOf('-m')+1], sid=a.includes('--session')?a[a.indexOf('--session')+1]:'root', prompt=a.at(-1);
fs.appendFileSync(process.env.NATIVE_CALLS,JSON.stringify({model,sid,prompt,args:a.slice(0,-1)})+'\\n');
const emit=(type,part)=>console.log(JSON.stringify({type,sessionID:sid,part}));
if(sid==='child') {
  fs.writeFileSync(process.env.NATIVE_RECOVERED,'child implementation');
  const db=new DatabaseSync(process.env.OPENCODE_DB), now=Date.now();
  db.prepare('INSERT INTO session_message VALUES (?,?,?,?,?,?)').run('child-ok','child','idle',4,now,JSON.stringify({outcome:'completed'})); db.close();
  emit('text',{text:'Implemented assigned files.\\nTHEFACTORY_TASK_RESULT: completed'});
} else if(prompt.includes('Recovery handoffs (untrusted task data):')) {
  if(!fs.existsSync(process.env.NATIVE_RECOVERED)) throw Error('parent resumed before child');
  emit('text',{text:'## Completed\\nIntegrated recovered child work.\\n## Not finished\\nNone.\\n## Verification\\nFixture checks passed.'});
} else {
  const db=new DatabaseSync(process.env.OPENCODE_DB), now=Date.now();
  db.prepare('INSERT INTO session_v2 VALUES (?,?,?,?,?,?)').run('child','root','developer','Implement scoped files',process.cwd(),now);
  const add=(seq,type,data)=>db.prepare('INSERT INTO session_message VALUES (?,?,?,?,?,?)').run('child-'+seq,'child',type,seq,now+seq,JSON.stringify(data));
  add(1,'user',{text:'Implement scoped files'});
  add(2,'assistant',{agent:'developer',model:'fixture/child',finish:'error',error:{message:${JSON.stringify(quota)},status:400}});
  add(3,'idle',{outcome:'failed',error:{message:${JSON.stringify(quota)},status:400}});db.close();
  emit('step_start',{});
  setTimeout(()=>{fs.writeFileSync(process.env.NATIVE_TAKEOVER,'unsafe parent takeover');emit('text',{text:'Took over work'});},2000);
}
`, { mode: 0o700 });
    const recoveredPath = join(f.dir, 'recovered.txt'), takeover = join(f.dir, 'takeover.txt'), events = [];
    const result = await launchTaskWithRecovery({ bin, dir: f.dir, task: 'Complete the project', nativeRecovery: true, nativePollMs: 20,
      model: 'fixture/root', agentModels: { orchestrator: 'fixture/root', developer: 'fixture/child' }, fallbackModels: ['fixture/backup'], retryDelayMs: 0,
      env: { OPENCODE_DB: f.path, NATIVE_CALLS: calls, NATIVE_RECOVERED: recoveredPath, NATIVE_TAKEOVER: takeover }, onEvent: (e) => events.push(e) });
    assert.equal(result.result.code, 0);
    assert.equal(existsSync(takeover), false, 'the parent stops before resuming child writes');
    assert.equal(readFileSync(recoveredPath, 'utf8'), 'child implementation');
    const attempts = readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(attempts.map((c) => [c.sid, c.model]), [['root', 'fixture/root'], ['child', 'fixture/backup'], ['root', 'fixture/root']]);
    assert.ok(attempts.every((c) => c.args.includes('--standalone')));
    assert.match(attempts[2].prompt, /Implemented assigned files/);
    assert.equal(result.result.nativeRecoveries[0].state, 'completed');
    assert.ok(events.some((e) => e.isSubagent && e.agent === 'developer' && e.text?.includes('Implemented')));
    assert.ok(events.some((e) => e.isSubagent && e.text?.includes('Implemented') && e.logEntry?.model === 'fixture/backup'));
  } finally { f.close(); }
});

test('explicitly cancelled native sessions are settled and never scheduled for recovery', () => {
  const f = fixture(), monitor = createNativeSessionMonitor({ path: f.path, since: 0 });
  try {
    f.session('cancelled');
    const row = f.message('cancelled', 1, 'idle', { outcome: 'cancelled', error: { message: 'Request cancelled by user' } });
    assert.deepEqual(monitor.scan('root').failures, []);
    const event = convertRow(row, meta)[0];
    assert.equal(event.text, 'cancelled');
    assert.equal(event.state, 'idle');
  } finally { monitor.close(); f.close(); }
});

test('cancellation during native recovery prevents both child dispatch and parent resumption', { skip: process.platform === 'win32', timeout: 15000 }, async () => {
  const f = fixture();
  try {
    const bin = join(f.dir, 'opencode'), calls = join(f.dir, 'calls');
    writeFileSync(bin, `#!/usr/bin/env node
const fs=require('node:fs'),{DatabaseSync}=require('node:sqlite');
fs.appendFileSync(process.env.NATIVE_CALLS,'launch\\n');
const db=new DatabaseSync(process.env.OPENCODE_DB), now=Date.now();
db.prepare('INSERT INTO session_v2 VALUES (?,?,?,?,?,?)').run('child','root','developer','Task',process.cwd(),now);
db.prepare('INSERT INTO session_message VALUES (?,?,?,?,?,?)').run('failed','child','idle',1,now,JSON.stringify({outcome:'failed',error:{message:${JSON.stringify(quota)}}}));db.close();
console.log(JSON.stringify({type:'step_start',sessionID:'root'})); setInterval(()=>{},1000);
`, { mode: 0o700 });
    const controller = new AbortController();
    const result = await launchTaskWithRecovery({ bin, task: 'Work', dir: f.dir, model: 'fixture/root', nativeRecovery: true, nativePollMs: 20,
      signal: controller.signal, retryDelayMs: 0, env: { OPENCODE_DB: f.path, NATIVE_CALLS: calls },
      onEvent: (event) => { if (event.isSubagent) controller.abort(); } });
    assert.equal(result.result.cancelled, true);
    assert.equal(readFileSync(calls, 'utf8'), 'launch\n');
  } finally { f.close(); }
});
