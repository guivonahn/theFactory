---
name: parallel-execution
agent: architect
description: Design task dependencies and file ownership for useful concurrent execution
triggers: [parallel, parallelization, concurrency, scheduler, workers, task graph]
---

Map the unit of work, dependency edges, resource ownership and observable
outcomes from the actual execution path. Distinguish separate processes from
isolated file workspaces. Parallelize independent readers and disjoint file
owners; consumers of changed files must depend on their producer.

Specify what each dependent task receives, when a failed dependency blocks it,
how cancellation reaches running processes and queued tasks, and how completion
is reflected in persisted state and the TUI. Include a compact ASCII flow and
source paths. Stay read-only and hand implementation changes to the developer.

Validation should demonstrate overlapping independent execution, serialized
conflicting scopes, failure propagation and cancellation without new dispatch.
Do not infer correctness or speedups solely from configured worker counts.
