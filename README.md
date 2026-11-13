# theFactory 🏭

A zero-dependency terminal visualizer for an orchestrator agent and its six
subagents: **explorer**, **architect**, **developer**, **reviewer**, **security**
and **tester**.

Packets travel between the centre box and each pillar while agents work. Run
`thefactory` to type a task; it drives a real `opencode run` session and shows
all subagent traffic live.

## Requirements

- Node.js 22 or newer
- The OpenCode CLI, with Coarena keys or OpenCode Go authentication (or the free profile)
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

The seven agent rows choose an independent **base model** for the orchestrator,
explorer, architect, developer, reviewer, security, and tester. Use ↑/↓ to
select a named agent row, then press Enter to open its model picker. The picker
lists Coarena Opus/Fable with key 1 and key 2 separately. ↑/↓ selects a model,
Enter applies it to that agent, and Esc cancels. ←/→ still cycles models.
Editing a model automatically
creates **Custom**, retaining the preset's effort level and every untouched
agent's model. The **all agents** row sets all seven agents together.

The profile row switches between presets and your saved Custom profile.
Selecting a preset keeps Custom available; editing a preset updates the
Custom slot. The active selection and complete Custom lineup persist in
`~/.config/thefactory/config.json` (or `$XDG_CONFIG_HOME/thefactory/config.json`).
Older per-agent settings are imported automatically. Changes apply to the next
task, including parallel workers, and temporary fallbacks never rewrite Custom.
Changing the profile immediately refreshes the displayed models and variants.
`--profile custom` selects the saved Custom profile explicitly.

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

With Coarena keys configured and the default profile, task mode starts on Claude Opus 5.5 and retries
in this order on quota/rate-limit errors: Opus key 1 → Opus key 2 → Fable 5.2
key 1 → Fable key 2 → the existing OpenCode Go pool. Only populated, distinct
keys are tried. The free profile keeps using its free-only pool.
Low/Medium/High keep their OpenCode Go lineup even when Coarena keys are
available. To use Coarena for just one agent, select that agent in `/config`.
Individual retries change only the running agent's model.

Fill in `.env` beside `package.json` (see `.env.example`):

```dotenv
COARENA_API_KEY_1=your_first_key
COARENA_API_KEY_2=your_second_key
```

Then run `node bin/theFactory.js` normally. The CLI loads these two variables
automatically; exported values take precedence. `.env` is ignored by Git.
The `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` instructions on Coarena's site
are for Claude Code and are not needed here.

On first use, theFactory adds the two Coarena aliases to the global OpenCode
provider allowlist. Credentials and agent model overrides are supplied to each
private OpenCode process, including parallel workers, without saving keys or
replacing the global agent lineup. Each new task probes Coarena again.

`--model coarena-1/claude-fable-5-2` selects Fable first. `--no-auto-fallback`
disables automatic retries; `--fallback-models` supplies a custom list instead.
Authentication/permission errors stop the run rather than triggering retries.

Coarena documents its model IDs, Anthropic endpoint, and account limits in
[its API docs](https://coarena.ai/docs). Two keys on the same account may share
limits; they do not guarantee twice the quota.

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
- Page Up / Page Down scroll a page; `g` / Home jumps to the oldest entry
- `G` / End returns to the latest entry; Space pauses or resumes following
- `f` cycles All / Messages / Tools / Errors
- `0` opens the orchestrator
- `1`–`6` jump to a pillar
- Esc or `q` closes

The viewer preserves Markdown, code indentation, and full multiline responses.
Code, JSON, shell commands, and diffs have syntax colors. Tool entries show
input/output, status and duration when OpenCode supplies them. The header
shows the agent's model and session. Each agent retains up to 500 entries;
individual tool content is capped at 32,000 characters with a visible notice.
Scrolling back holds your place while new events arrive.

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
