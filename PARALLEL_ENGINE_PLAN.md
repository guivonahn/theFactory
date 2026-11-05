# Parallel engine — engineering plan (workin_on)

## Before / after
- Before: single-run `opencode run --format json` (`src/run.js`), one active run,
  TUI shows one orchestrator + 6 pillars, no DAG.
- After (target): DAG scheduler (`src/scheduler.js`) + independent OpenCode
  workers (server backend, see Phase 2) + isolated worktrees + integration.

This document is a checkpoint, not completion. Only pieces listed as Done are implemented.

## Server backend decision (Phase 2, verified v2.0.15)
- `POST /api/session` create: verified.
- `POST /api/session/:id/prompt {text}` async: verified (steer delivery).
- `GET /api/session/:id/message` transcript: verified.
- `GET /api/session/:id/permission` list + `GET .../permission/:id`: verified live
  (pending blocks execution; shape {id, sessionID, action, resources, save, source}).
- `POST .../permission/:id/reply {decision}`: route + `decision` field verified;
  decision enum values **UNVERIFIED** (free-quota 429 blocked enum probe).
  Docs UI outcomes are once/always/reject; API enum must be probed again when quota recovers.
- Session cancel: `DELETE /api/session/:id` verified (204).
- `opencode run` backend **cannot** do interactive approve (stdin ignore, no permission
  event) — long-term workers must use `opencode serve` + REST/SSE.

## Done
- DAG task model + validator (dup/missing/cycle/self-dep) — `src/scheduler.js`.
- State machine pending/ready/running/completed/failed/blocked/cancelled,
  deterministic priority+order dispatch, concurrency cap (default 3),
  no duplicate dispatch, failure→blocked propagation, capped retries, sequential mode,
  event bus, `runTasks` with measured-overlap test.
- Permission hardening: `--auto` opt-in (default safe), warning, narrow `workin_on`
  allow (template + idempotent global sync), no silent success.
- Worker manager on `opencode run --agent` independent processes (per-worker session
  ID, role, lifecycle, cancellation hook; same-role instances allowed) — `src/worker.js`
  (server backend note: serve+reply is the long-term path; run-backend workers ship now).
- Structured event bus with attribution/dedupe — `src/events.js`.
- Isolated Git worktrees per write task + dirty preservation + manifest + overlap/
  base-mismatch checks — `src/workspaces.js` (manual temp-repo proof, dirty intact).
- Integration with conflict blocking (never silently picks) — `src/integrate.js`.
- Persistence/reconcile + bounded jittered backoff — `src/parallelState.js`.
- Serve client for long-term backend (`src/serve.js`): session create, prompt,
  messages, permission list/get, reply `POST …/permission/:id/reply {decision}`,
  delete, plus `startServe` lifecycle. Decision enum still UNVERIFIED (allows
  caller to pass the literal decision; client never guesses).
- Deeper TUI panel: center box lists first 2 workers (`role:task state`) plus
  counts in status line — real data only (`src/app.js`, `src/main.js --parallel`).
- Safe resume: `resumePlan()` only auto-resumes read-only/idempotent work;
  write tasks go to needsReview (never blind-rerun). `thefactory --resume <dir>`
  prints resumable/needsReview/interrupted from `parallel-state.json`
  (`src/parallelState.js`, `src/main.js`).

## Not yet done (DoD outstanding)
- Interactive permission TUI once `decision` enum is verified; wire serve client
  as the default worker transport (run-backend workers still ship for now).
- Deeper TUI lines beyond 2 workers (data present, display capped for narrow terminals).
- Real-provider two-session overlap proof — **not yet verified** (free quota 429;
  all 5 free models return quota; `OC-NOLIMIT/*` returns no-route). Blocked on account quota / Go subscription.
- Stateful long-running parallel runs with auto-resume (reconcile + plan exist; auto-rerun not blind).

## Checkpoint
- `npm test` — 36/36 (scheduler + events/worker/integrate/backoff/reconcile/resume + serve client + panel + CLI).
- Parent repo untouched; all work on `feature/parallel-execution-engine` in `workin_on/`.
