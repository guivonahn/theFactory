---
name: implementation
agent: developer
description: Implement scoped features and fixes with evidence and regression checks
triggers: [implement, implementation, feature, fix, bug, regression, refactor]
---

Trace the requested behavior through its real caller and existing tests before
editing. Identify the contract being preserved or changed. Use the repository's
existing conventions and dependencies.

Own only the assigned file scope. Other workers may be editing different files
in the same checkout; preserve their changes and avoid blanket resets or broad
formatting. If a required shared file is outside the scope, hand that requirement
back to the coordinator instead of racing another owner.

Implement the complete assigned behavior. For a bug, add a regression check
that exercises its trigger rather than mirroring the patch. Run the smallest
meaningful checks and report their exact outcomes. Hand off changed paths,
relevant contracts, commands actually executed, and unresolved blockers.
