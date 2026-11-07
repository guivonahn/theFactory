# theFactory 🏭

A zero-dependency terminal visualizer for an orchestrator agent and its six
subagents: **explorer**, **architect**, **developer**, **reviewer**, **security**
and **tester**.

Packets travel between the centre box and each pillar while agents work. Run
`thefactory` to type a task; it drives a real `opencode run` session and shows
all subagent traffic live.

## Requirements

- Node.js 22 or newer
- The OpenCode CLI, authenticated with OpenCode Go for the default models
- A terminal of at least **60×24**

There are no npm dependencies and nothing to install.

## Quick start

```sh
node bin/theFactory.js                     # task mode
node bin/theFactory.js "fix the tests"     # prefill a task
node bin/theFactory.js --demo              # scripted demo
node bin/theFactory.js --live              # watch a real session
```

Optionally link the command:

```sh
npm link
thefactory
```

## Screenshots

```


                                   ▐█▌
        ┌▓▓▓┐‾/\‾/\‾/\‾/\‾/\‾/\‾/\‾▐█▌      ██████ ░████░ ░█████ ██████ ░████░ ██████ ██░░██
        │▓▓▓│░░▪░░░░▪░░░░▪░░░░▪░░░░▐█▌  the ██░░░░ ██░░██ ██░░░░ ░░██░░ ██░░██ ██░░██ ░░██░░
        │▓▓▓│░░░░░░░░░░░░░░░░░░░░░░▐█▌      █████░ ██████ ██░░░░ ░░██░░ ██░░██ █████░ ░░██░░
        └▓▓▓┘▪▪░▪▪░▪▪░▪▪░▪▪░▪▪░▪▪░░▐█▌      ██░░░░ ██░░██ ░█████ ░░██░░ ░████░ ██░░▟█ ░░██░░

  ┌──────────── EXPLORER ────────────✓┐                      ┌──────────── ARCHITECT ───────────◐┐
  │ » Explore the auth surface: rout… │                      │ » Map module boundaries and the … │
  │ « Found 3 relevant files: src/au… │──────++       ++─────│ « Proposed AuthService + Session… │
  │ msg:2 tool:2                      │      ││       ││     │ msg:3 tool:1                      │
  └───────────────────────────────────┘      ││       ││     └───────────────────────────────────┘
                                        ┌── ORCHESTRATOR ──┐
                                        │ › ← architect:   │
                                        │ Wrap-up:         │
                                       ││                  ││
  ┌──────────── DEVELOPER ───────────✓┐││ msgs 19 · tools… ││┌──────────── REVIEWER ────────────✓┐
  │ » Implement AuthService with a S… │││ ◐ 1/6 agents wo… │││ » Review the diff for regression… │
  │ « Wrote src/auth.js and src/sess… ││└──────────────────┘││ « 2 nits: guard refresh, rename … │
  │ msg:4 tool:5                      ││││                ││││ msg:4 tool:1                      │
  └───────────────────────────────────┘ ││                ││ └───────────────────────────────────┘
                                        ││                ││
                                        ││                ││
                                        ││                ││
                                        ││                ││
  ┌──────────── SECURITY ────────────✓┐ ││                ││ ┌───────────── TESTER ─────────────✓┐
  │ » Audit token storage, SQL param… │ ││                ││ │ » Run the auth and session suite… │
  │ « No injection paths. Rotate the… │──+                +──│ « 18 pass, 1 fail: the refresh p… │
  │ msg:2 tool:1                      │                      │ msg:4 tool:2                      │
  └───────────────────────────────────┘                      └───────────────────────────────────┘
 theFactory · demo · 19 msgs · 0 packet(s) · q quit                                          100×32
```

- **Task** — type a task, press Enter, watch OpenCode work and the six pillars
  light up. This is the default in a terminal.
- **Demo** — a deterministic scripted workflow for trying the UI.
- **Live** — replay or follow an existing OpenCode session.
- **Snapshot** — plain-text frames for pipes and logs.

## Task mode basics

| Key | Action |
| --- | --- |
| Enter | run the task |
| Esc | abort the running task |
| Ctrl-C | quit |
| `q` | quit only when the composer is empty |

Composer commands:

```
/new  /sessions  /resume <id|#n>  /fallback  /models  /volume  /config  /log
```

`/config` opens an editable card for the model, profile, verbosity, fallbacks,
auto-approve, parallelism, nolimit, graphify and sound volume settings.

## Sounds

`pop.mp3` plays when an agent is called (orchestrator → subagent, worker
starts, pillar tools), `error.mp3` on failures (failed tasks, tool errors,
pillar failures), and `completed.mp3` when a task finishes successfully.
`/volume` shows or sets the volume — `/volume 50`, `/volume mute`,
`/volume on`, `/volume +10` — and persists it across runs.
The `/config` card's `volume` row cycles `0 (muted) / 25 / 50 / 80 / 100`.
Flags: `--volume <0-100>`, `--mute` / `--no-sound`; env: `FACTORY_VOLUME`,
`FACTORY_SOUND=0`. Volume is passed to the audio player itself
(`afplay -v` on macOS, `ffplay -volume` / `mpv` / `mpg123` elsewhere); the OS
output volume is left untouched. Snapshot frames stay silent.

## Model profiles

- `low`, `medium`, `high` apply model variants to every agent.
- `free` pins every agent to an `opencode/*-free` model, so no subscription is
  needed.
- Switching back to a paid level restores the OpenCode Go lineup.

Set a profile with `--profile low|medium|high|free` or the `/config` profile row.

Auto-fallback (on by default): when a model hits a usage/rate limit, theFactory
automatically retries on the next model in the active pool (OpenCode Go models
for paid profiles, `opencode/*-free` models for the free profile) instead of
failing. Toggle it in `/config` (`autoFallback` row) or with
`--auto-fallback` / `--no-auto-fallback` (env `FACTORY_AUTO_FALLBACK=0`).
Manual lists via `--fallback-models` / `/fallback` disable auto-fallback and
use your list instead. Single runs and parallel workers both retry.

## Verbosity

`--verbosity low|medium|high` (or the `/config` verbose row) controls how much
agents talk, in order to reduce token usage. It applies to every agent.

## Questions and images

- OpenCode question forms open in a popup. Use arrows to pick an option, type a
  custom answer where allowed, Enter submits, Esc cancels.
- Images produced by tools or linked in Markdown open in a popup. Press `o` to
  open the file externally.

## Logs

`/log` opens the per-agent log viewer, even while a task is running.

- `←` / `→` switch agents
- `↑` / `↓` scroll
- `1`–`6` jump to a pillar
- Esc or `q` closes

## Graphify

On by default. theFactory reuses `graphify-out/graph.json` or runs
`graphify update <dir>`, then adds code-graph guidance to task prompts. Disable
it with `--no-graphify` or `FACTORY_GRAPHIFY=0`.

## Optional opencode-nolimit

The bundled `OC-NOLIMIT` proxy is still available as a fallback:

```sh
thefactory nolimit status
```

It needs Bun and is only started when an `OC-NOLIMIT/*` model is selected.

Full documentation: [docs/REFERENCE.md](docs/REFERENCE.md)
