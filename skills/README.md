# Skills

Skill files live here. Each skill is a markdown file with YAML frontmatter that
declares its name, the agent it applies to, a description, and trigger keywords.

## Format

```markdown
---
name: code-review
agent: reviewer
description: Review code changes for quality, bugs, and best practices
triggers:
  - review
  - pr
  - diff
  - audit
  - quality
---

Instructions go here. The orchestrator reads these and delegates matching tasks
to the named agent, which receives the full skill body as part of its worker
prompt.
```

## Built-in skills

- `code-review.md` → reviewer — reviews diffs and code quality
- `security-audit.md` → security — hunts for risk and vulnerabilities
- `test-generation.md` → tester — designs checks and runs existing tests; hands new test code to the developer
- `architecture-map.md` → architect — maps verified architecture and prepares implementation handoffs
- `exploration.md` → explorer — maps the terrain and researches
- `implementation.md` → developer — implements scoped changes and meaningful regression checks
- `terminal-interface.md` → developer — terminal geometry, motion, controls and rendering
- `parallel-execution.md` → architect — dependencies, ownership, failure and cancellation

Built-in skills ship with the package and load from any target repository.
Project skills from `<target>/skills/` (or `FACTORY_SKILLS_DIR`) override a built-in
skill with the same name. `README.md` is documentation, not a skill.

Add skills by dropping a `.md` file into that directory. Trigger matching supports
whole words and phrases; full instructions are injected only into the assigned
role. The orchestrator gets a catalog for routing. The read-only tester, reviewer,
security, explorer and architect do not receive implementation instructions.

Role contracts are appended to existing agent system prompts for each OpenCode
process, preserving configured models and permissions. The persistent global
configuration is not rewritten to install these prompts.
