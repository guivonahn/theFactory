---
name: architecture-map
description: Inspect a real codebase and produce a verifiable ASCII architecture diagram on every Architect invocation; maintain the canonical, human-readable docs/architecture/ARCHITECTURE.md map without changing source code. Distinguish implemented from proposed components and keep evidence paths.
license: MIT
compatibility: opencode
metadata:
  role: architect
  output: ascii-architecture-map
  artifact: docs/architecture/ARCHITECTURE.md
---

# Architecture Map — Architecture Agent Skill

## Mission

Create a **source-grounded, terminal-readable, continuously maintained ASCII map** of the active project. The canonical artifact is:

`docs/architecture/ARCHITECTURE.md` (relative to the **target project's repository root**).

The Architect MUST include a current-state ASCII diagram in **every architectural response**, even when the request is just a question, an option comparison, or a small design change. It MUST refresh the canonical artifact when the inspected implementation differs from the stored map. A skill is only loaded on demand: the Architect's permanent prompt must explicitly require `skill({ name: "architecture-map" })` for every invocation (see INSTALLATION.md).

**Do not fabricate components, connections, entry points, or runtime behavior.** A clear `unknown / not verified` is more useful than a confident guess.

## Activation / output contract

On every Architect invocation:

1. Load this skill before any architectural recommendation.
2. Identify the **target repository**. Never mistake theFactory's own orchestration repository, a spawned task worktree, and the user's target application for the same project.
3. Inspect enough of the **actual files** to substantiate a diagram. On follow-ups, inspect the affected region and check the stored diagram; do not blindly reuse it.
4. Produce the diagram in the Architect response under **Current architecture (ASCII)**. Even if the on-disk document is already current, show the relevant project-level diagram in the reply.
5. Create or revise `docs/architecture/ARCHITECTURE.md` **if write permissions and workspace ownership permit**. Do not change implementation source files, configs, or other documentation to satisfy this skill.
6. If read-only, in a disposable worktree, or otherwise unable to persist the canonical file: **provide the complete updated Markdown document as a handoff** to the orchestrator/integrator; state `NOT SAVED` explicitly and do not claim the map was updated.
7. Name the file location and say whether it was **updated**, **already current**, or **not saved**.

**Never claim persistence unless a write succeeded and the resulting document was read back or otherwise confirmed.**

## Source-of-truth investigation

Look for relevant evidence, not just filenames. Depending on the project, inspect:

- Repository shape, packages/workspaces, manifests, build commands, deployment definitions.
- Runtime entry points, CLI/UI/API routes, services, adapters, controllers, background workers.
- Domain modules, shared libraries, persistence interfaces, schemas/migrations, caches.
- Message queues, event buses, agents/orchestrators, external APIs, authentication and trust boundaries.
- Actual call/import paths, data reads/writes, worker lifecycle, task routing, and failure recovery.
- Tests that establish integration contracts; latest relevant diff when it changes architecture.

Prefer implementation evidence over README claims. For each substantial box or connection, be able to cite at least one repository-relative path in the **Evidence and confidence** section. If permission to execute shell commands is unavailable, use read/list/search tools only. Do not fetch secrets or expose `.env` values, credentials, tokens, private keys, or user data. No unnecessary build/run/network calls.

If the repo is large, use progressive disclosure: scan the high-level entry points first, then trace important interfaces, not every leaf file. Limit scope to the target system and clearly identify intentionally omitted submodules.

## Drawing conventions

- Use plain **7-bit ASCII only**, inside a fenced `text` block. No Mermaid, Unicode borders, emojis, or embedded images in place of the ASCII drawing.
- Prefer <= 100 characters per line and readable at an 80-column terminal where practical.
- Use `+----+`, `|`, `-`, `v`, `^`, `<`, `>`, and arrows `-->` / `<--`.
- Show **real architectural units** (processes, services, packages, storage, runtime boundaries), not one box per source file.
- Label meaningful edges (HTTP, call, event, queue, DB read/write, RPC, IPC, file, etc.) when verified.
- Separate external systems from project-owned systems with a visible boundary or grouping.
- Show direction of data/control; do not equate import dependencies with runtime communication.
- Include a **legend** for ambiguous link types. If a relationship is uncertain, use `?` and explicitly describe what remains unverified.
- Keep the main overview between 5 and 15 boxes when possible. If needed, add one narrower detail diagram for a critical subsystem rather than one enormous unreadable map.
- Make the diagram reflect **CURRENT IMPLEMENTATION**, never silently mix in intended future architecture. Put proposals in a separate `Proposed changes (not yet implemented)` section/diagram when relevant.

Minimal FORMAT EXAMPLE ONLY — this is not a claim about the user's repository:

```text
+-------------------- PROJECT --------------------+
|                                                  |
|  +----------+    HTTP    +-------------------+   |
|  | Web / UI | ---------> | Application API   |   |
|  +----------+            +-------------------+   |
|                                |                 |
|                          reads/writes            |
|                                v                 |
|                          +-----------+           |
|                          | Database  |           |
|                          +-----------+           |
+--------------------------------------------------+
                    |
                    | outbound API
                    v
             +-----------------+
             | External system |
             +-----------------+
```

Never copy the example as a project diagram without verifying each box and edge.

## Canonical document contract

At `docs/architecture/ARCHITECTURE.md`, use this structure:

````markdown
# Project architecture

<!-- BEGIN AUTO-GENERATED ARCHITECTURE MAP -->
## Scope and verification
- Repository: ...
- Revision / branch: ... (only if known)
- Verification: ... (timestamp only if known; otherwise `not recorded`)
- Status: verified / partial

## Current architecture (ASCII)
```text
... diagram ...
```

## Components and responsibilities
| Component | Responsibilities | Evidence |
|---|---|---|
| ... | ... | `path/to/file` |

## Interactions and data flow
- ... label the actual message and data boundaries ...

## Boundaries and risks
- ... auth / trust / failure boundaries if relevant ...

## Evidence and confidence
- Confirmed: `path/to/file` ...
- Unverified: ...

## Proposed changes (not yet implemented)
- ... optional; never put proposed features in the current-state diagram ...
<!-- END AUTO-GENERATED ARCHITECTURE MAP -->

## Human notes
(Optional, never auto-delete.)
````

**Update rules**:

- If the document exists, replace only the text between the two `AUTO-GENERATED` markers, preserving every byte of text before/after when feasible. If the markers are missing, preserve the existing document and add a clearly delimited generated section rather than destructively overwriting content.
- If there are no architecture-impacting changes, do not rewrite the file unnecessarily; say `already current` after reviewing it.
- The diagram and component/evidence table must agree. Remove obsolete boxes after confirming their removal. Do not invent Git SHA, timestamps, line numbers, or tests.
- Prefer a single canonical file rather than duplicated diagrams across workspaces.

## theFactory orchestration and parallel-worktree rule

In a multi-agent run, **the Architect owns architectural analysis, not merging or integration**. The orchestrator owns ensuring the canonical map is present in the accepted/integration repository state.

- If the Architect runs read-only, emit the full proposed Markdown document as a handoff; the orchestrator assigns the **developer/integrator** to write it.
- If the Architect runs in an isolated, disposable Git worktree, do not report that a file written there is the canonical project map. Hand it to the integrator for the accepted branch.
- If a task is only *planned* or rejected, include the design under `Proposed changes` but DO NOT modify the current-state diagram to pretend the code already implements it.
- If a change is merged/accepted, refresh the current-state diagram against the integrated code and then persist the canonical file.
- Do not create an extra agent or trigger the entire pipeline **solely** to redraw an unchanged map. Respect adaptive orchestration.

## Mandatory Architect response ending

Always finish architectural responses with:

1. `Current architecture (ASCII)` — actual diagram or the correctly scoped subsystem diagram with a pointer to the overall map.
2. `Evidence` — exact source paths plus unknowns.
3. `Architecture map` — `docs/architecture/ARCHITECTURE.md` and one of: `updated and verified`, `already current`, or `NOT SAVED (handoff required)`.
4. `Proposed changes` — only when requested; never blended into current state.

## Quality gate / non-negotiables

- Do not label a design-only diagram as implemented.
- Do not infer RPC, queueing, persistence, concurrency, security guarantees, or data direction merely from naming conventions.
- Do not modify source code or security settings to satisfy a documentation request.
- Do not save an architecture map into an unrelated app/worktree.
- Do not report successful persistence unless the intended canonical repo contains the file.
- If verification is partial, say what was inspected and what is unknown.
