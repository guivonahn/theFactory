# theFactory reference

Everything theFactory can do: modes, flags, commands, configuration, and
implementation notes.

## Install-free usage

Requires Node.js 22 or newer (the app uses `node:sqlite`). There are no npm
dependencies; nothing is downloaded or installed.

```sh
node bin/theFactory.js                          # task mode (TTY) / demo snapshot (pipe)
node bin/theFactory.js "fix the failing tests"  # prefill the task composer
node bin/theFactory.js --picker                 # choose a live session
node bin/theFactory.js --demo                   # scripted workflow
node bin/theFactory.js --live --session <id-or-slug>
node bin/theFactory.js --list                   # print live sessions as a table
```

Optionally link the command locally:

```sh
npm link
thefactory
```

## Models and profiles

The default lineup uses `opencode-go/*` models from OpenCode Go. An active
subscription and authentication through OpenCode's `/connect` command are
required.

| Agent | Default model |
| --- | --- |
| orchestrator | `opencode-go/glm-5.3` |
| architect | `opencode-go/deepseek-v4-pro` |
| explorer | `opencode-go/mimo-v2.6-flash` |
| developer | `opencode-go/kimi-k3.1-pro` |
| reviewer | `opencode-go/claude-haiku-5-5` |
| security | `opencode-go/grok-4.7` |
| tester | `opencode-go/glm-5.3-flash` |

Choose a Go model explicitly for task mode:

```sh
thefactory --model opencode-go/kimi-k3.1-pro
```

### Paid profiles

`--profile low|medium|high` (or the `/config` profile row) applies each agent's
exact or nearest declared model variant to the global default and every
configured agent. Models without variants keep their base id. When two variants
are equally close, the lower-effort one wins.

Switching back to `(default)` removes variant suffixes and restores the shipped
Go lineup, including after using the free profile.

### Free profile

`--profile free` pins every agent to a free model. It needs no OpenCode Go
subscription and no `OC-NOLIMIT` proxy.

| Agent | Free model |
| --- | --- |
| orchestrator | `opencode/crouton-alpha-free` |
| architect | `opencode/deepseek-v4.1-flash-free` |
| explorer | `opencode/mimo-v2.6-flash-free` |
| developer | `opencode/flint-40b-free` |
| reviewer | `opencode/beam-free` |
| security | `opencode/nemotron-3.5-super-vl-free` |
| tester | `opencode/nemotron-3.5-lightning-free` |

Selecting a specific model from the `/config` model row while the free profile
is active exits the free profile, because the free profile pins all agents.

## Verbosity

`--verbosity low|medium|high` (or the `/config` verbose row) controls how much
agents talk, to minimize token usage. It applies to every agent's system prompt.

- `low` — answer-first, maximally terse, no preamble or routine tool narration.
- `medium` — concise prose, brief rationale only where useful.
- `high` — include essential evidence, reasoning, verification details, and
  `file:line` references.

The instruction is appended behind a fixed marker, so changing the level
replaces the previous block and `(default)` removes it without touching the
rest of the prompt. CLI flags are applied when task mode starts; `/config`
changes apply immediately to the global OpenCode config.

## Built-in opencode-nolimit

The OpenAI-compatible `opencode-nolimit` proxy remains bundled as an optional
fallback; it is not the default provider. It provides a free OpenCode model
pool without installing a second repository. Bun and the OpenCode CLI are
required to run the proxy.

```sh
thefactory nolimit status
thefactory nolimit models
thefactory nolimit key
```

Task execution can launch the bundled proxy, wait for it to become healthy, and
add the generated local API key to `~/.config/opencode/opencode.json` as the
`OC-NOLIMIT` provider. Its models remain available for explicit fallback
selection as `OC-NOLIMIT/big-pickle` or
`OC-NOLIMIT/deepseek-v4.1-flash-free`. The proxy starts only when an
`OC-NOLIMIT/*` model is selected (or the config toggle is on), so Go-only runs
do not depend on Bun or the proxy.

## Task mode

```sh
thefactory
thefactory --model opencode-go/kimi-k3.1-pro
thefactory --profile high
thefactory --profile free
thefactory --verbosity low
thefactory --no-graphify
thefactory --opencode /path/to/opencode --dir /path/to/project
thefactory --session <id-or-slug>
thefactory --new
```

Bare `thefactory` in a TTY opens the visualizer with a `task> ` composer at the
bottom. Enter submits the text to a real `opencode run --format json` process.
Passing task text as positional arguments prefills the composer; OpenCode's
stdout stream drives the orchestrator activity and tool counters. The first
`sessionID` in that stream is used to attach read-only DB polling, so child
sessions and their messages appear under the six agent pillars as they are
created. Completed tasks leave a small centre log, then refocus the composer for
the next task.

### Keys in task mode

| Key | Action |
| --- | --- |
| printable characters | edit the task (append) |
| Backspace | delete the last character |
| Enter | submit a non-empty task |
| Esc | abort the active run with `SIGTERM` (the OpenCode session is kept) |
| Ctrl-C | quit immediately |
| `q` | quit only when the composer is empty |
| `/log` + Enter | open the log viewer (also while a task is running) |

A task may start with the letter L; bare `l` is no longer a shortcut in task
mode. Use `/log`.

### Composer commands

Typed in place of a task; they never spawn `opencode run`.

| Command | Action |
| --- | --- |
| `/new` (or `/fresh`) | Forget the current session and delete the persisted id. |
| `/sessions` | List up to 12 recent root sessions in the centre log (`*current*` marks the active one). |
| `/resume <id\|#n>` | Set the session the next task will continue. `#n` refers to the latest `/sessions` listing. |
| `/fallback [list]` | Show or set quota fallback models (comma-separated, max 8; `/fallback clear` resets). |
| `/models` | List OpenCode Go models available for fallback. |
| `/config` | Open the configuration card. |
| `/log` | Open the per-agent log viewer. |

### Configuration card

`/config` opens an editable card. Up/down selects a row; Enter or `→` changes it;
`←` changes it backwards; `q` or Esc closes.

| Row | Values |
| --- | --- |
| `model` | `(default)`, the user's custom model, then the OpenCode Go presets. Applies globally to all agents and the default. |
| `profile` | `(default) → LOW → MEDIUM → HIGH → FREE`. |
| `verbose` | `(default) → LOW → MEDIUM → HIGH`. |
| `fallbacks` | `(none)`, single-model presets, then the user's custom list. |
| `auto` | ON / OFF. |
| `parallel` | OFF / 3 workers / 4 workers / 6 workers. |
| `sequential` | ON / OFF. |
| `nolimit` | ON / OFF (starts the bundled proxy). |
| `graphify` | ON / OFF (default ON). |
| `dir` | Read-only working directory. |
| `session` | Read-only current session. |

Changing `model` preserves the active paid profile. The free profile is cleared
by an explicit model change because it pins every agent.

## Question forms

OpenCode question forms are surfaced by the shared server. theFactory polls the
session for pending forms and shows them in a popup on top of the visualization.

- The popup shows the form title, current field, help text, options, validation
  errors, and progress through the fields.
- `↑` / `↓` pick an option. For string fields with options, typing selects the
  custom-answer row and uses what you type.
- `←` / `→` set boolean values.
- Space toggles multiselect items; Enter commits the field and advances.
- Enter on the last field submits `{answer: {...}}`.
- Esc cancels and dismisses the form.
- `o` on an external field opens its URL.
- Fields support `string`, `number`, `integer`, `boolean`, `multiselect`, and
  `external`, including conditional `when` rules and required/min/max checks.

Transport used by the TUI:

```
GET    /api/session/{sessionID}/form
POST   /api/session/{sessionID}/form/{formID}/reply   {"answer": {...}}
DELETE /api/session/{sessionID}/form/{formID}
```

The headless `opencode run` process does not currently expose the question tool
itself; polling answers forms raised by the shared server or another client.

## Images

Image outputs are detected from tool metadata (`type: "file"` with an
`image/*` MIME type), image tool inputs (for example `read`,
`experimental_image_generate`), and Markdown/HTML image links in text output.

Detected images appear in a popup with their name, MIME type, and path/URL.

| Key | Action (image open) |
| --- | --- |
| `o` | Open externally with `open` / `xdg-open` / `start`. |
| Esc or `q` | Close. |

Apple Terminal has no inline-image protocol, so the popup shows the target and
opens it externally. Image detection is cycle-safe and never fails JSONL
parsing.

## Log viewer

`/log` opens a full per-agent log overlay, including while a task is running.
Every message, tool, and status event is kept in a capped (500-entry) per-agent
history; the overlay shows one agent at a time on a cleared background box.

| Key | Action (log open) |
| --- | --- |
| `←` / `→` | cycle agent (orchestrator → explorer → architect → developer → reviewer → security → tester → other) |
| `↑` / `↓` | scroll back / forward |
| `1`–`6` | jump straight to explorer / architect / developer / reviewer / security / tester |
| Esc or `q` | close the overlay (does **not** abort a running task) |

The orchestrator log shows the centre log plus the current activity line.
Pressing Esc while the overlay is closed aborts a running task as before. In
live and demo modes there is no composer, so bare `l` still opens the log.

## Graphify

Graphify reuses `<dir>/graphify-out/graph.json` or runs `graphify update <dir>`
before normal and parallel tasks, then adds query/path/explain guidance to the
run prompts (not slash commands or planner prompts).

Use `--no-graphify` or `FACTORY_GRAPHIFY=0` to disable it; `--graphify`
re-enables it. The `/config` graphify row toggles it at runtime. Missing
binaries, timeouts, and update failures are logged and never fail the task.

Prompt guidance covers:

```sh
graphify query "..."
graphify path "A" "B"
graphify explain "X"
```

## Session persistence

Task mode keeps context across tasks **within one process run**: the first task
creates a new session and its `sessionID` is stored, so later tasks pass
`--session <id>` to `opencode run` instead of starting over. The id is also
written to `$XDG_STATE_HOME/thefactory/session.json`
(or `~/.local/state/thefactory/session.json`) as
`{ sessionID, dir, updatedAt }`, so the next `thefactory` invocation in the same
directory resumes it. A persisted id that points at a different directory is
ignored. The status line shows whether the current run is `new` or `continued`
and the session id prefix.

| Flag | Task-mode semantics |
| --- | --- |
| `--session <id\|slug>` (or `--attach`) | Continue that session (passed to `opencode run` as `--session`) and persist it. |
| `--new` / `--fresh` | Ignore the persisted session; the next task starts a brand-new one. |
| `--auto` / `--no-auto` | `--auto` is explicit opt-in for trusted unattended use (auto-approves `ask`; warns at run start). Default omits `--auto`; last flag wins. `deny` stays enforced either way. |

## Parallel mode

```sh
thefactory --parallel                 # scheduler, default 3 workers
thefactory --workers 6                # set the worker limit
thefactory --sequential               # force single-worker execution
thefactory --resume <dir>             # print a safe resume plan from parallel-state.json
```

The planner splits a task into scoped tasks, the scheduler runs independent
tasks concurrently, and integration detects overlapping file writes and blocks
conflicts instead of copying them. `--resume` only prints a safe plan; it never
auto-reruns write work.

## Demo mode

```sh
thefactory --demo
```

Plays a deterministic "build feature X" workflow: explorer → architect →
developer, then tester/reviewer/security in parallel, a fix cycle, and finally
an orchestrator summary. Events are spread over about 14 seconds.

## Live mode

```sh
thefactory --picker
thefactory --live                      # TTY: picker, then follow
thefactory --live --attach <id-or-slug> --dir /path/to/project
thefactory --live --session <id-or-slug> --no-follow --fast
```

In a TTY, `--live` without `--session` opens the session picker; `--picker` does
the same explicitly. In a pipe, `--live` renders the newest root session as a
snapshot. `--attach` is an alias for `--session`.

Reads `~/.local/share/opencode/opencode.db` **read-only**. It only queries the
`session_v2` and `session_message` tables; credential and account tables are
never touched. The database is opened with
`new DatabaseSync(path, { readOnly: true })`, with `SQLITE_BUSY` retries.
Because the DB is in WAL mode a read-only connection sees committed updates.

Only child sessions whose agent is one of the six known roles are mapped to
pillars. Any other agent (`build`, etc.) shares the grey **OTHER** box.

## Snapshot and pipes

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
| `--model <provider/model#variant>` | Forwarded to `opencode run` as `-m`. `#variant` is optional and provider-specific. Task mode only. |
| `--profile low\|medium\|high\|free` | Apply a model profile globally. `free` pins every agent to an `opencode/*-free` model. |
| `--verbosity low\|medium\|high` | Append a talkativeness instruction to every agent prompt. |
| `--fallback-models <csv>` | Fallback models tried in order on quota/no-route (max 8). `FACTORY_FALLBACK_MODELS` also works. |
| `--auto` / `--no-auto` | Pass (opt-in) or omit `--auto` for `opencode run`. Task mode only. See Task mode above. |
| `--graphify` / `--no-graphify` | Enable or disable code-graph preparation (default ON). `FACTORY_GRAPHIFY=0` also disables it. |
| `--parallel` | Enable the planner + scheduler. |
| `--workers <n>` | Worker/concurrency limit (default 3, min 1). Implies `--parallel`. |
| `--sequential` | Force single-worker execution. |
| `--resume <dir>` | Load `parallel-state.json` from `dir` and print a safe resume plan. |
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
cursor, and raw mode are restored in a `finally`-style teardown, including on
errors and `SIGINT`, and an active task child is terminated.

The layout requires at least **60×24**. Smaller terminals get a friendly message
and exit code 1. `SIGWINCH` resizes rebuild geometry.

## Security and permissions

Task mode defaults to **safe** mode: no `--auto` is injected. Interactive
approval is impossible through `opencode run` — stdin is `ignore` and no
permission event exists in the JSONL stream. An `ask` match therefore aborts
headlessly with
`! permission requested: <action> (<pattern>); auto-rejecting` on stderr plus
`Tool execution interrupted` / `Step interrupted` on JSONL (exit 1). The TUI
surfaces that line as `⚠ permission requested: ...` and tool denials as
`⚠ Permission denied: ...` instead of an opaque failure. A permission failure is
never silent success: even on exit 0 the run reports `error` when a
permission/tool denial was seen.

Pass `--auto` only for trusted unattended executions (warns at run start);
`--auto` auto-approves `ask` rules (for example `external_directory`, `*.env`,
`rm -rf*`, `kubectl apply*`, `aws *`). `deny` rules remain enforced in both
modes (for example `git push` still fails with `Permission denied: shell`).

A narrow `external_directory` allow for this `workin_on/` workspace is kept in
`config/opencode/opencode.json` and synced idempotently to the live global
config by `src/nolimit.js` — no global allow-all, no `/Users/guivonahn/*`
wildcard. The last of `--auto` / `--no-auto` wins.

## How it works

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

Question forms and image metadata ride on top of the same JSONL parsing, plus
polling of the shared server's form API.

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

The frame is divided into a central 7-row box and six pillars in three bands
(top pair, middle pair, bottom pair). Vertical placement is fixed to the bands;
horizontal placement uses a percentage-width pillar and a centre box sized to
leave a gap. Branch paths are precomputed orthogonal `{row, col}` arrays:
top/bottom pillars leave the centre's top/bottom edge at 30%/70% width, go
vertically to the pillar's middle row, then horizontally to the box edge;
middle pillars leave the centre's left/right edge horizontally. Each path is
also reversed for inbound packets. The renderer keeps two character/style grids,
clears the back grid each frame, computes changed cells against the last flushed
frame, and emits `\x1b[row;colH` cursor moves only for changed runs.

Agent boxes are intentionally compact but sized to stay readable:
`max(17, min(28, round(width * 0.27)))` columns wide, and 5 rows below a
34-row terminal, 6 rows at 34–35, and 7 rows at 36+.

## Project layout

```
bin/theFactory.js   thin executable entry
src/main.js         CLI parsing, picker, snapshot, TTY loop, task wiring
src/input.js        raw-mode task composer / line editing
src/run.js          opencode run launcher + tolerant JSONL parser + image extraction
src/agents.js       six-agent registry + grey fallback
src/canvas.js       character/style grids, diff flush, wrapping, boxes
src/layout.js       radial geometry and orthogonal branch paths
src/app.js          state machine, packets, run status, rendering, overlays
src/demo.js         deterministic workflow timeline
src/live.js         read-only SQLite backfill + incremental polling
src/plan.js         parallel task planning
src/scheduler.js    dependency-aware worker scheduler
src/worker.js       independent parallel worker prompts
src/integrate.js    write-conflict detection and integration
src/parallelState.js parallel run state
src/profiles.js     model variants + free/paid profile application
src/verbosity.js    global agent verbosity prompts
src/graphify.js     code-graph preparation and prompt guidance
src/forms.js        question form state and key handling
src/media.js        image detection and OS opener
src/opencodeApi.js  `opencode api` request wrapper
src/nolimit.js      built-in opencode-nolimit management
test/               node:test suites and the JSONL fixture
```

## Notes and honest deviations

- `OPENCODE_DB` can override the database path, which is handy for tests.
- Outbound events carry a `to` field; the event sketch only shows `from`, but a
  target is required to route the packet.
- Unknown agents share one grey **OTHER** box at bottom-centre instead of a
  seventh arbitrary ring position.
- Agent feeds show the last two messages as one truncated line each.
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
- Bare `l` is a log shortcut only in demo/live modes. Task mode uses `/log`, so
  tasks can start with L.
- Headless `opencode run` does not expose the question tool, so form polling
  answers forms from the shared server or another client. The popup still
  renders and replies through the same API.
- Apple Terminal cannot inline images; the popup shows the target and `o` opens
  it with the OS handler.
- Graphify is best-effort: a missing binary or failed update only logs a warning
  and the task continues without graph guidance.
