# Factory, crew and parallel engine review

The selected worker is an original square dumpling: a chunky body, small
hard hat, stubby paws and boots. The bean and puff remain in `--worker-preview`
for comparison. The selected design is used for all real agents; the preview
contains local illustrative states and does not start an agent task.

## Repairs and improvements

| Area | Change |
| --- | --- |
| Data tracks | Reserve two gutter columns on each side. Route both directions around workers and merge corners/junctions from the actual paths. Attach lanes to explicit card ports. |
| Animation | Six poses for each state, individual phases, one completion jump, precomputed sprite atlas, existing render clock, no extra timers or dependencies. |
| Responsive layout | Keep all workers, names and statuses at 60×24. Expand feeds and skyline when space allows. Keep auxiliary agents clear of the orchestrator. |
| Resize | A small-terminal hint replaces exiting a running session. Rebuild in-flight packet routes while preserving their progress. |
| Readability | Give agent titles their identity colors even when idle. Make tracks visible with palette tokens. Display failure as failure in logs and compact cards. |
| Feed | Show the latest messages instead of the first messages in the retained feed. Preserve full history in the log overlay. |
| Composer | Render the actual caret, retain whitespace, follow the edited line in pasted text, and account for wide characters. |
| Output | Strip internal wide-character continuation markers from ANSI output and snapshots. |
| Footer | Reserve space for terminal dimensions and retain essential controls on small terminals. |
| Controls | Enable number-key log shortcuts in demo/live mode. Ctrl-C works from overlays. Worker clicks open logs when mouse reporting is enabled. |
| State | Give explicit running/completion states precedence over completion keywords; failures containing “incomplete” remain failures. Fix elapsed duration for tasks started at clock zero and include auxiliary agents in the working denominator. |
| Motion and color | Support `--reduced-motion`, `FACTORY_REDUCED_MOTION=1`, `REDUCE_MOTION=1`, `TERM=dumb`, `NO_COLOR`, truecolor, and the existing 256-color fallback. Hidden scenes stop rendering beneath overlays. |

## Verification

- Automated geometry checks cover widths 60–220, heights 24–65, task/demo footers,
  all worker states/designs/roles, and auxiliary agents.
- Track regressions verify continuous cell steps, avoid every worker footprint,
  and check that the rendered lanes remain visible after cards and creatures.
- Composer, feed, footer, failure, duration, resizing, and Unicode output have
  regression coverage alongside the existing configuration/form/image/log tests.
- A real PTY run exercised truecolor, independent animation, numeric log
  shortcuts, 60×24 resizing, shrinking to 40×15 and restoring, and Ctrl-C from
  an overlay. It restored the cursor and alternate screen, emitted no NULs,
  and cleared the screen only on entry. A 400 ms animation sample emitted
  1,449 bytes of diffs.
- GIF previews are rasterizations of actual TUI canvas frames, using Menlo;
  terminal font fallback and glyph appearance can vary.

The renderer still uses a lightweight code-point width model. Complex emoji
graphemes and combining sequences need a separate renderer enhancement; this
change verifies single-cell creature glyphs and existing wide-character cases.

## Factory animation and logo

The header uses a faceless industrial factory with a sawtooth roof, stack
exhaust, uniform window bays and a production conveyor. The angular three-row
wordmark has a fixed amber accent. The caption reflects running,
idle, failed or completed work. Larger terminals reserve six or seven header
rows so the conveyor and steam do not disappear as cards grow. Tiny headers
retain a miniature factory and the `theFactory` name.

Art uses the existing clock, color tokens and diff canvas. Reduced motion holds
the exhaust, conveyor and window sequence still. Completed agent cards say
“task complete”; they no longer display a waiting message beside a checkmark.

Runtime artwork lives in `src/factory.js`, which is included in package output.
The old `workin_on/factory.js` remains a compatibility re-export. Configuration
templates and built-in skills now ship in the package as well.

## Parallel work

Independent tasks start up to the configured concurrency. Overlapping declared
read/write file or directory scopes serialize; multiple readers can overlap.
Unknown write scopes and wildcard scopes acquire a conservative shared lock.
Consumers of changed code still need explicit dependencies on their producer.
These are scheduling locks over declared scopes in a shared checkout, not
filesystem isolation or enforcement of arbitrary shell commands.

Failures now reach the DAG instead of resolving as successful worker records.
Their dependents remain blocked while unrelated branches can complete. Any
failed or blocked work makes the final run incomplete. Dependency outputs are
passed as bounded handoffs, and persisted task snapshots retain their actual
terminal states. Cancellation stops queued dispatch and reaches the running
processes. Escalation timers are tied to the aborted run.

The TUI counts all workers, displays multiple active workers per role, and keeps
a role active while any of its workers are running. The center reports running
slots, waiting tasks, completions and blocked/failure counts from scheduler state.

## Agent instructions and skills

Per-process role contracts preserve existing system instructions, model choices
and permissions. Developer tasks own implementation; read-only roles produce
findings and handoffs. New implementation, terminal-interface and parallel-execution
skills complement the existing specialist skills. Skill bodies are routed by
role and trigger; project definitions override bundled skills by name.

The architecture skill now declares its actual role and triggers. The tester
skill respects its existing read-only permissions. Built-ins load when targeting
another repository, and documentation is excluded from skill discovery.

## Additional verification

- Scheduler checks cover read/write locks, path aliases, synchronous exceptions,
  bounded retries, dependency handoffs and cancellation before queued dispatch.
- Real fixture processes verify primary-model selection, worker failures,
  successful consumers and cancellation. No provider requests are made.
- A complete TUI fixture run launched independent branches concurrently, blocked
  a failed branch's consumer, passed a successful producer's output onward and
  persisted `failed/completed/blocked/completed` states. A cancellation run launched
  only its first worker and persisted all tasks as cancelled.
- Per-process role contracts reached the fixture child environment. This checks
  transport and routing; model adherence to instructions was not evaluated.
- `npm pack --dry-run` verified the factory runtime, role contracts, configuration
  template and skill assets are present. Nothing was published.
- Updated [factory preview](factory-preview.gif) frames come directly from the
  actual canvas; `--factory-preview` is a local illustrative scene.

## Prompt progress and closing overview

The footer measures completed plan steps plus the final recap step. It does not
estimate completion from elapsed time, message count, or worker animation.
Unknown totals use an indeterminate bar, with a fixed pose under reduced motion.
Native `todowrite` events supply step states when available. The bar reaches
100% after successful completion and overview delivery; partial and cancelled
runs retain their incomplete progress.

Parallel runs perform a final text-only orchestrator synthesis with every task
outcome and bounded worker report excerpts. Tool access is denied for this
recap process. Failed or unavailable synthesis falls back to the full outcome
record, including failure/blocking reasons and tester reports. Cancellation
does not launch another recap call. The final overview is saved alongside the
parallel state and shown in an automatic scrollable view, reopenable with
`/overview`.

Native runs retain multipart text responses and require Completed, Not finished,
and Verification sections in the orchestrator contract. An explicit unfinished
section or incomplete todo list prevents a successful run classification.
Workers end with an explicit `THEFACTORY_TASK_RESULT: completed|incomplete`
declaration for their assigned acceptance criteria. A failed process or an
unresolved `incomplete` declaration blocks dependents. Disputed successful
read-only investigations receive the bounded review described below. A generic prose `Not finished` section
is retained as a limitation, not interpreted as an acceptance failure. Missing
declarations are recorded as `unreported`; a process completion alone is not
proof of acceptance or verification.

Regression coverage checks measured/unknown progress, partial completion,
multipart reports, recap fallback, tool denial, overview scrolling/reopening,
and the factory's absence of face glyphs. Local PTY fixtures exercise full and
partial native runs at 60×24, final parallel synthesis, and cancellation without
a recap request. Provider inference quality has not been evaluated.


## Parallel regression and named crew refinement

The reported six-task failure was traced to the saved TOT run: the explorer
returned an inventory and entry-point map with exit 0, but mentioned tests not
run and an unavailable/stale Graphify graph under `Not finished`. Those were
outside its mapping acceptance criteria. The prose heuristic incorrectly failed
that task and blocked four consumers. Explicit task acceptance declarations now
separate those cases, while the overview preserves the reported limitations.
The scheduler still blocks genuine process failures and unresolved incomplete
acceptance. Worker errors, acceptance declarations, and blocking dependencies
are retained in saved state; the final feed shows root task errors once.

The named crew has square hands and feet. Denver's keyboard has separate keys
and a spacebar; Firewall has a taller flame plume over staggered brick joints;
Mosby has a five-row building with window rows and a door. Those three props
expand with roomy cards and have compact versions at 60×24. Orchestration role
keys, model routing, and permission rules retain their canonical names.

Smoke puffs have a visible outline and drift from the stack. Short headers give
the building a three-row silhouette; session labels use free space beside the
artwork. Reduced motion keeps one static plume while running.

The standalone macOS Terminal profile uses Fira Code Regular 14 with no startup
command. Official Fira Code 6.2 TTFs were installed per-user on this machine and
font discovery verified; the existing default Terminal profile was preserved.
Generated crew previews use Fira Code, rendered from the actual TUI canvas.

## Missing optional files and disputed acceptance

A subsequent saved run demonstrated a second failure mode: XP supplied the
requested project/entry-point/dependency/module map, but declared it incomplete
because an optional root README did not exist. The declared acceptance did not
require that README. An explicit result marker alone therefore did not solve
false failures from model judgment.

Scope paths are now explicitly search hints. The planner allows one explorer
for a project explanation, avoids unrelated test/implementation tasks, and
adds dependencies only for required producer results. It no longer requires a
duplicate summary task, since final synthesis already runs independently.

When a successful read-only investigator process declares incomplete, one
orchestrator turn reassesses its report against the exact assigned criterion.
Tools are denied. Approval must cite existing numbered report lines; the runtime
extracts and retains the exact evidence instead of trusting generated quotes.
The review has a 60-second budget and honors cancellation. Unavailable, malformed,
unsupported or negative reviews preserve the original failure. Implementation,
tester and nonzero-process failures are not eligible for this override.

Original and effective declarations, review reason/evidence and limitations are
saved together. Consumers receive the runtime state and review before the raw
report. The final overview retains those decisions and limitations.

The installed CLI also reported `opencode/crouton-alpha-free` unavailable. The
Free preset's orchestrator now uses `opencode/glm-5.3-flash-free`, verified by an
actual text-only review of the saved failing report. Stale Crouton routes were
removed from the Free fallback pool. Saved Custom selections are preserved.
