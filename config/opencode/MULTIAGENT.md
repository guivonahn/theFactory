# Zero-Cost Multi-Agent OpenCode Setup

Installed for OpenCode **v2.0.15** on **2026-11-05**.

## Architecture

```text
USER REQUEST
     |
     v
ORCHESTRATOR (primary, glm-5.3-flash-free#high)
     |
     +--> EXPLORER  (mimo-v2.6-flash-free)        read-only, fast
     +--> ARCHITECT (flint-40b-free#high)         read-only, design
     |
     +--> DEVELOPER (deepseek-v4.1-flash-free#high)  implementation owner
     +--> TESTER    (nemotron-3.5-lightning-free)     runs tests, no edits
     +--> REVIEWER  (big-pickle)                     read-only review
     +--> SECURITY  (nemotron-3.5-super-vl-free#high) read-only security
     |
     v
ORCHESTRATOR reconciles findings and delivers the result
```

The workflow is adaptive: simple questions are answered directly; small changes may
be done by the orchestrator; substantial work uses the smallest useful subset of the
subagents. Independent investigations can run concurrently. Only the developer owns
implementation files.

## Agents and models

| Agent | Mode | Model | Context | Role |
| --- | --- | --- | --- | --- |
| orchestrator | primary | `opencode/glm-5.3-flash-free#high` | 200k | planning, delegation, integration |
| architect | subagent | `opencode/flint-40b-free#high` | 262k | read-only design and tradeoffs |
| explorer | subagent | `opencode/mimo-v2.6-flash-free` | 200k | read-only fast code exploration |
| developer | subagent | `opencode/deepseek-v4.1-flash-free#high` | 200k | implementation |
| reviewer | subagent | `opencode/big-pickle` | 200k | read-only correctness review |
| security | subagent | `opencode/nemotron-3.5-super-vl-free#high` | 1M | read-only security review |
| tester | subagent | `opencode/nemotron-3.5-lightning-free` | 262k | test execution, no edits |

All models have an explicit **$0 input / $0 output / $0 cache** price in the
installed catalog. Verified on 2026-11-05.

## Provider policy

`experimental.policies` is used because OpenCode 2.0.15 predates top-level
`policies`. It currently enforces:

```json
[
  { "action": "provider.use", "resource": "*", "effect": "deny" },
  { "action": "provider.use", "resource": "opencode", "effect": "allow" }
]
```

Only the `opencode` provider is usable, so a missing free model cannot silently
fall back to a paid provider. The stored OpenAI credential is preserved but hidden
by this policy. To use another provider deliberately, add an `allow` statement
after the broad `deny`, and move the block to top-level `policies` after upgrading
to an OpenCode version that supports it.

## Usage

The orchestrator is the default primary agent:

```bash
opencode
```

For a one-shot task:

```bash
opencode run "Add pagination to the users endpoint and verify the tests"
```

To select it explicitly:

```bash
opencode run --agent orchestrator "Refactor the billing module"
```

In an interactive session, use the agent selector if you want to switch primary
agents. Subagents are not selected manually; the orchestrator launches them through
the native `subagent` tool.

### One-command MAS launch

OpenCode's model selector lists models, not agents. There is no native way to make
an agent appear as a model entry. The supported single-entry launcher is the global
`/mas` command:

```text
Ctrl+P  ->  type "mas"  ->  Enter  ->  type the task
```

Or type it directly in the prompt:

```text
/mas Fix the failing tests and verify them
```

`/mas` switches the current session to the `orchestrator` agent before submitting
the prompt. The command is defined in `~/.config/opencode/commands/mas.md` and is
listed in the Ctrl+P command palette as:

```text
MAS — run the zero-cost multi-agent orchestrator on this task
```

For the agent selector instead of the command palette:

```text
Ctrl+X A   list agents
Shift+Tab  cycle primary agents
```

The orchestrator remains the default primary agent, so plain `opencode` already
uses MAS without any selection.

Example routing for a feature request:

```text
User: "Add rate limiting to the API"
  orchestrator
    -> explorer   (find middleware, config, existing cache usage)
    -> architect  (only if the design is non-trivial)
    -> developer  (implement)
    -> tester     (run tests)
    -> reviewer   (review diff)
    -> orchestrator delivers summary + verification evidence
```

## Safety model

- `git push`, force-push, branch deletion, publishing, and production deploys are
  denied or require approval.
- Destructive filesystem commands (`rm -rf`, disk tools, privilege escalation)
  require approval or are denied.
- `.ssh`, `.aws`, `.gnupg`, `.kube`, `.netrc`, `.npmrc`, and env files are protected.
- Read-only agents have native `edit` and `shell` denials. They cannot create files
  even if asked; verified by probes.
- Subagents cannot launch further subagents (`experimental.subagent_depth: 1` plus
  per-agent `subagent` deny).
- The developer is the only implementation owner during delegated work.

## Changing a model

List verified free models:

```bash
opencode models
```

Pick another `opencode/*-free` model, update the agent's `model` in
`~/.config/opencode/opencode.json`, then reload:

```bash
opencode reload
```

Do not use a model merely because its name contains "free". Confirm its cost in
`/api/model` (or the model selector) before assigning it.

## Files

- `~/.config/opencode/opencode.json` — global model, default agent, agents,
  permissions, provider policy.
- `~/.config/opencode/commands/mas.md` — the `/mas` one-command launcher.
- `~/.config/opencode/MULTIAGENT.md` — this document.
- `~/.config/opencode/backups/2026-11-05-pre-multiagent/` — pre-change backup of
  the previous config, CLI settings, auth, and the disabled OmniRoute plugin.

## Reverting

```bash
cp ~/.config/opencode/backups/2026-11-05-pre-multiagent/opencode.json \
   ~/.config/opencode/opencode.json
cp ~/.config/opencode/backups/2026-11-05-pre-multiagent/cli.json \
   ~/.config/opencode/cli.json
cp ~/.config/opencode/backups/2026-11-05-pre-multiagent/auth.json \
   ~/.local/share/opencode/auth.json
opencode reload
```

The OmniRoute plugin is preserved at
`~/.config/opencode/backups/2026-11-05-pre-multiagent/plugins-disabled/omniroute`.
