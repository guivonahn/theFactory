/**
 * Scripted "build feature X" workflow used by --demo. Timestamps are
 * virtual milliseconds so the same timeline can be played live or jumped
 * through instantly for snapshots.
 */

const event = (at, payload) => ({ at, event: payload });
const msgOut = (to, text) => ({ kind: 'msg', from: 'orchestrator', to, dir: 'out', text });
const msgIn = (from, text) => ({ kind: 'msg', from, dir: 'in', text });
const tool = (from, text) => ({ kind: 'tool', from, text });
const status = (from, text) => ({ kind: 'status', from, text });

/** Return the deterministic demo timeline as `[{at, event}]`. */
export function demoEvents() {
  return [
    event(100, status('orchestrator', 'plan · ship feature X behind a flag')),
    event(450, msgOut('explorer', 'Explore the auth surface: routes, session storage, middleware.')),
    event(950, tool('explorer', 'grep auth')),
    event(1400, tool('explorer', 'read src/auth.js')),
    event(2050, msgIn('explorer', 'Found 3 relevant files: src/auth.js, src/session.js, middleware/guards.js')),
    event(2450, status('orchestrator', 'explorer delivered · drafting module boundaries')),
    event(2650, status('explorer', 'done · 3 files mapped')),

    event(2850, msgOut('architect', 'Map module boundaries and the login → refresh → logout flow.')),
    event(3350, tool('architect', 'sketch graph')),
    event(3950, msgIn('architect', 'Proposed AuthService + SessionStore; 4 files, no schema changes.')),
    event(4350, status('architect', 'done · design stable')),

    event(4500, msgOut('developer', 'Implement AuthService with a SQLite-backed session store.')),
    event(4950, tool('developer', 'edit auth.js')),
    event(5300, tool('developer', 'edit session.js')),
    event(5800, tool('developer', 'node --test')),
    event(6500, msgIn('developer', 'Wrote src/auth.js and src/session.js; 2 tests still pending.')),

    event(6900, status('orchestrator', 'implementation ready · fan out validation')),
    event(7050, msgOut('tester', 'Run the auth and session suites; focus on refresh races.')),
    event(7150, msgOut('reviewer', 'Review the diff for regressions and naming issues.')),
    event(7250, msgOut('security', 'Audit token storage, SQL parameters and secret defaults.')),
    event(7600, tool('tester', 'npm test')),
    event(7700, tool('reviewer', 'read diff')),
    event(7800, tool('security', 'scan secrets')),

    event(8450, msgIn('tester', '18 pass, 1 fail: the refresh path double-inserts a session.')),
    event(8850, msgIn('reviewer', '2 nits: guard refresh, rename store.get → store.read.')),
    event(9250, msgIn('security', 'No injection paths. Rotate the default secret and cap TTL at 7d.')),

    event(9700, msgOut('developer', 'Fix the refresh race, rename store.get, rotate the default secret.')),
    event(10150, tool('developer', 'patch refresh lock')),
    event(10500, tool('developer', 'regression test')),
    event(11050, msgIn('developer', 'Patched the refresh lock and added a regression test.')),

    event(11400, msgOut('tester', 'Re-run the suites against the patched branch.')),
    event(11500, msgOut('reviewer', 'Re-check the two nits and the lock ordering.')),
    event(11800, tool('tester', 'npm test')),
    event(12150, msgIn('tester', '19/19 pass · refresh race is gone.')),
    event(12500, msgIn('reviewer', 'Approved; naming and guard clauses look right.')),

    event(12800, status('developer', 'done')),
    event(12900, status('reviewer', 'done · approved')),
    event(13000, status('security', 'done · no blockers')),
    event(13100, status('tester', 'done · 19 passing')),
    event(13250, status('orchestrator', 'summary · auth shipped, 19 tests green, no security blockers')),
    event(13500, msgIn('architect', 'Wrap-up: confirm the rollout flag defaults off.')),
  ];
}

/** Play the demo in wall-clock time; returns a handle with stop(). */
export function playDemo(app, options = {}) {
  const speed = options.speed ?? 1;
  const timers = [];
  const timeline = demoEvents();
  for (const entry of timeline) {
    timers.push(
      setTimeout(() => {
        app.applyEvent(entry.event);
        options.onEvent?.(entry.event);
      }, Math.round(entry.at / speed)),
    );
  }
  const last = timeline[timeline.length - 1]?.at ?? 0;
  timers.push(
    setTimeout(() => {
      options.onDone?.();
    }, Math.round((last + 1400) / speed)),
  );
  return {
    duration: last,
    stop() {
      for (const timer of timers) clearTimeout(timer);
    },
  };
}
