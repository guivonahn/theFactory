# theFactory 🏭

A zero-dependency, full-screen terminal visualizer for an orchestrator agent and
the six subagents it delegates to: **explorer**, **architect**, **developer**,
**reviewer**, **security** and **tester**.

Packets travel along branch lines as agents send messages back and forth. Each
pillar keeps a tiny live feed, status dot, and message/tool counters, while the
centre box shows the orchestrator's current activity and totals.

Run bare `thefactory` in a terminal to type a real task. It spawns
`opencode run --format json`, watches the stream, and attaches to the root
session in `opencode.db` so subagent traffic appears in the same visualization.

```
  ┌────── EXPLORER ─────✓┐                                                ┌───── ARCHITECT ─────●┐
  │ » Explore the auth … │                                                │ « Proposed AuthServ… │
  │ « Found 3 relevant … │───────────────+                +───────────────│ « Wrap-up: confirm … │
  │ msg:2 tool:2         │               │                │               │ msg:3 tool:1         │
  └──────────────────────┘               │                │               └──────────────────────┘
                                         │                │
                             ┌───────────── ORCHESTRATOR ─────────────┐
  ┌───── DEVELOPER ─────✓┐   │ › ← architect: wrap-up received        │   ┌────── REVIEWER ─────✓┐
  │ » Fix the refresh r… │   │ rollout flag defaults off.             │   │ » Re-check the two … │
  │ « Patched the refre… │───│                                        │───│ « Approved; naming … │
  │ msg:4 tool:5         │   │ msgs 19 · tools 12 · ~tok 269          │   │ msg:4 tool:1         │
  └──────────────────────┘   │ ◐ 1/6 agents working                   │   └──────────────────────┘
                             └────────────────────────────────────────┘
  ┌────── SECURITY ─────✓┐                                                ┌─────── TESTER ──────✓┐
  │ » Audit token stora… │                                                │ » Re-run the suites… │
  │ « No injection path… │────────────────────────────────────────────────│ « 19/19 pass · refr… │
  │ msg:2 tool:1         │                                                │ msg:4 tool:2         │
  └──────────────────────┘                                                └──────────────────────┘
 theFactory · demo · 19 msgs · q quit                                             100×32
```

## Install-free usage

Requires Node.js 22 or newer (the app uses `node:sqlite`). There are **no npm
dependencies**; nothing is downloaded or installed.

```sh
node bin/theFactory.js              # task mode (TTY) / demo snapshot (pipe)
node bin/theFactory.js "fix the failing tests"  # prefill the task composer
node bin/theFactory.js --picker     # choose a live session
node bin/theFactory.js --demo       # scripted workflow
node bin/theFactory.js --live --session <id-or-slug>
node bin/theFactory.js --list       # print live sessions as a table
```

Optionally link the command locally:

```sh
npm link
thefactory
```

## Modes

### Task mode

```sh
thefactory
thefactory --model openai/gpt-5#high
thefactory --opencode /path/to/opencode --dir /path/to/project
```

Bare `thefactory` in a TTY opens the visualizer with a `task> ` composer at the
bottom. Enter submits the text to a real `opencode run --format json` process.
Passing task text as positional arguments prefills the composer;
OpenCode's stdout stream drives the orchestrator activity and tool counters.
The first `sessionID` in that stream is used to attach read-only DB polling, so
child sessions and their messages appear under the six agent pillars as they are
created. Completed tasks leave a small centre log, then refocus the composer for
the next task.

Keys in task mode:

| Key | Action |
| --- | --- |
| printable characters | edit the task (append) |
| Backspace | delete the last character |
| Enter | submit a non-empty task |
| Esc | abort the active run with `SIGTERM` (the OpenCode session is kept) |
| Ctrl-C | quit immediately |
| `q` | quit only when the composer is empty |

`--model` is forwarded as `-m`; `--opencode` (or `FACTORY_OPENCODE`) overrides
the binary; `--dir` is the child process working directory. A missing binary
shows `opencode binary not found — set FACTORY_OPENCODE or install opencode`
and returns to the prompt. Task-mode snapshots are intentionally not supported.

### Demo

```sh
thefactory --demo
```

Plays a deterministic "build feature X" workflow: explorer → architect →
developer, then tester/reviewer/security in parallel, a fix cycle, and finally an
orchestrator summary. Events are spread over about 14 seconds.

### Live

```sh
thefactory --picker
thefactory --live                      # TTY: picker, then follow
thefactory --live --attach <id-or-slug> --dir /path/to/project
thefactory --live --session <id-or-slug> --no-follow --fast
```

In a TTY, `--live` without `--session` opens the session picker; `--picker`
does the same explicitly. In a pipe, `--live` renders the newest root session
as a snapshot. `--attach` is an alias for `--session`.

Reads `~/.local/share/opencode/opencode.db` **read-only**. It only queries the
`session_v2` and `session_message` tables; credential and account tables are
never touched. The database is opened with `new DatabaseSync(path, { readOnly:
true })`, with `SQLITE_BUSY` retries. Because the DB is in WAL mode a read-only
connection sees committed updates.

Only child sessions whose agent is one of the six known roles are mapped to
pillars. Any other agent (`build`, etc.) shares the grey **OTHER** box.

### How it works

```
task text
   │
   ├─ spawn `opencode run --format json <task>`
   │       └─ stdout JSONL: text / tool / error / step_* — parsed tolerantly
   │              ├─ text  → orchestrator feed + centre log
   │              ├─ tool  → centre pulse + tool counter (subagent/task fans out)
   │              └─ error → red status and the stderr tail
   │
   └─ first event.sessionID
          └─ LiveSource(root) → poll opencode.db every second
                 └─ session_v2 children with parent_id = root
                        └─ explorer / architect / developer / reviewer /
                           security / tester pillars + message packets
```

The JSONL stream is the authoritative live signal; the database tail fills in
the subagent sessions it discovers. Both are read-only and neither writes to
`opencode.db`.

### Snapshot / pipes

```sh
thefactory --snapshot              # one highest-evolved demo frame, plain text
thefactory --snapshot 3 --demo     # three frames separated by a form feed
thefactory --snapshot --live --session kind-mountain
thefactory --snapshot --demo | less
```

When stdout is not a TTY, `--demo` and `--live` automatically render a snapshot
instead of entering the alternate screen. `--task` and `--picker` require a TTY
and exit 1 in a pipe. Snapshot mode never writes alternate screen codes, cursor
hides, or colour escapes. `NO_COLOR` is honoured in TTY mode as well.

## CLI flags

| Flag | Semantics |
| --- | --- |
| `--task` | Explicit task mode. Requires a TTY. |
| `--picker` | Explicit session picker, then live follow. Requires a TTY. |
| `--demo` | Use the scripted workflow. |
| `--live` | Use OpenCode sessions. Without `--session` in a TTY, open the picker. |
| `--attach <id\|slug>` | Alias for `--session`. |
| `--session <id\|slug>` | Exact id, id prefix, or exact slug. A child id is climbed to its root. |
| `--model <provider/model#variant>` | Forwarded to `opencode run` as `-m`. Task mode only. |
| `--opencode <path>` | OpenCode binary. `FACTORY_OPENCODE` also works. Task mode only. |
| `--dir <path>` | Prefer root sessions whose `directory` equals or ends with the path; task working directory. |
| `--snapshot [n]` | Render `n` plain-text frames (default `1`) and exit 0. The final frame is fully evolved. No alternate screen / hidden cursor. Task mode is not snapshot-capable. |
| `--limit <n>` | Latest `n` messages replayed **per session** (default `200`). |
| `--packet-speed <ms>` | Backfill pacing: one event per tick (default `400` ms). |
| `--fast` | Replay backfill at roughly 10× speed (40 ms ticks). |
| `--follow` / `--no-follow` | Poll the DB every second for new rows. Follow defaults on in a TTY. |
| `--list` | Print root sessions (id, slug, agent, child count, title) and exit 0. No TUI. |
| `-v`, `--version` | Print the installed version. |
| `-h`, `--help` | Usage. |

In demo/live TTY mode, `q` or `Ctrl-C` exits cleanly. The alternate screen,
cursor and raw mode are restored in a `finally`-style teardown, including on
errors and `SIGINT`, and an active task child is terminated.

The layout requires at least **60×24**. Smaller terminals get a friendly message
and exit code 1. `SIGWINCH` resizes rebuild geometry.

## Event model

`src/app.js` consumes events shaped like:

```js
{ kind: 'msg', from: 'orchestrator', to: 'explorer', dir: 'out', text: '...' }
{ kind: 'msg', from: 'developer', dir: 'in', text: '...' }
{ kind: 'tool', from: 'tester', text: 'npm test' }
{ kind: 'tool', from: 'orchestrator', text: 'task', fanout: true, to: 'explorer' }
{ kind: 'status', from: 'orchestrator', text: '...' }
```

`dir: 'out'` sends a packet centre → agent and prefixes the feed with `»`.
`dir: 'in'` sends a packet agent → centre and prefixes the feed with `«`.
Tool events pulse the branch for about a second and spawn a quick packet series.
An orchestrator tool with `fanout` pulses the centre and sends packets to all six
pillars (or only `to` when the subagent name is known).
Status events update the centre activity line or an agent's idle/working/done dot.
`src/run.js` maps `opencode run` JSONL into this shape; `src/live.js` maps DB rows.

## Layout math

The frame is divided into a central 7-row box and six 5-row pillars in three
bands (top pair, middle pair, bottom pair). Vertical placement is fixed to the
bands; horizontal placement uses a 25%-width pillar and a centre box sized to
leave a gap. Branch paths are precomputed orthogonal `{row, col}` arrays:
top/bottom pillars leave the centre's top/bottom edge at 30%/70% width, go
vertically to the pillar's middle row, then horizontally to the box edge;
middle pillars leave the centre's left/right edge horizontally. Each path is
also reversed for inbound packets. The renderer keeps two character/style grids,
clears the back grid each frame, computes changed cells against the last flushed
frame, and emits `\x1b[row;colH` cursor moves only for changed runs.

## Project layout

```
bin/theFactory.js   thin executable entry
src/main.js         CLI parsing, picker, snapshot, TTY loop, task wiring
src/input.js        raw-mode task composer / line editing
src/run.js          opencode run launcher + tolerant JSONL parser
src/agents.js       six-agent registry + grey fallback
src/canvas.js       character/style grids, diff flush, wrapping, boxes
src/layout.js       radial geometry and orthogonal branch paths
src/app.js          state machine, packets, run status, rendering
src/demo.js         deterministic workflow timeline
src/live.js         read-only SQLite backfill + incremental polling
test/               node:test suites and the JSONL fixture
```

## Notes and honest deviations

- `OPENCODE_DB` can override the database path, which is handy for tests.
- Outbound events carry a `to` field; the spec's event sketch only showed
  `from`, but a target is required to route the packet.
- Unknown agents share one grey **OTHER** box at bottom-centre instead of a
  seventh arbitrary ring position.
- Agent feeds show the last two messages as one truncated line each (matching
  the ~5-line box), rather than multi-line wrapped paragraphs.
- `node:sqlite` is synchronous. Poll queries are scheduled from a 1-second
  interval between render ticks, but a very large query can still block the
  loop for its duration.
- Raw mode is enabled for all TTY interactive modes (including `--demo`), not
  only live-follow, so `q` works everywhere.
- `--snapshot N` joins frames with a form feed (`\f`) for easy splitting.
- Task mode attaches to the first `sessionID` immediately, retrying DB discovery
  for a short window while OpenCode commits the new session. Any backfill is
  applied immediately; the live JSONL stream is the real animation source.
- In task mode `q` quits only on an empty composer, so a task cannot start with
  a bare `q`. Use Ctrl-C when in doubt.
- No `--auto` is injected into `opencode run`; permission behavior is whatever
  OpenCode is configured to do.
