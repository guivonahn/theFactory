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
- `test-generation.md` → tester — writes and proves behaviour with tests
- `architecture-design.md` → architect — designs system shape and boundaries
- `exploration.md` → explorer — maps the terrain and researches

Add new skills by dropping a `.md` file here; they are auto-discovered at startup.
