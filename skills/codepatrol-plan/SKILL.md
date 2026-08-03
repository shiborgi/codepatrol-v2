---
name: codepatrol-plan
description: Execute Plan for one explicit Codepatrol Work and produce a decision-complete v1 handoff for Review.
---

# Codepatrol Plan

Use `codepatrol` from `PATH`, with `node bin/codepatrol.js` as the in-repository fallback. Use the truthful harness and model supplied by the adapter. Always pass the absolute main repository root with `--workspace`.

1. Resolve exactly one explicit Work ID. Never select by recency.
2. Inspect through `work show` and `change show`; require `Backlog` ready for Plan, Plan ready after a return, or an active Plan run. Never read `.codepatrol/**` directly.
3. If the base moved, consider `change refresh` before starting the ready Plan attempt. Never refresh an active run.
4. Create a non-empty todo and mirror it in the harness task facility. Write todo JSON to an absolute temporary path outside the repository and all worktrees.
5. If ready, start Plan. Every stage start attaches the Work's own worktree at `.codepatrol/runtime/worktrees/<work-id>` and returns it as `worktreeDirectory`, so Plan runs against the Work's worktree rather than the repository's main checkout. Inspect product paths at the returned `inspectionRef`. `work checkout` is only needed when a fresh checkout is required outside a stage. Todo, trace, and result JSON must still be written to absolute paths outside the repository and all worktrees.
6. If active, use `resume` with the existing run ID. Never call `start` again for an active attempt.
7. Produce a decision-complete plan without editing production code. Planning notes and command files are evidence, not product artifacts. Declare only intentional, committed product files as artifacts.
8. Record concise decisions, observations, actions, failures, and relevant command outcomes with `trace --input`.
9. Complete with `decision: "continue"`; Plan has no return decision. The result must answer every starting todo ID in order.
10. Report the result and the exact Review start command without invoking Review.

Use complete command forms. Every JSON path is absolute and outside the repository and its worktrees:

```bash
codepatrol --workspace /absolute/path/to/repository \
  plan start <work-id> \
  --harness <harness> \
  --model <model> \
  --todo /absolute/path/outside/repository/plan-todo.json

codepatrol --workspace /absolute/path/to/repository \
  plan resume <work-id>

codepatrol --workspace /absolute/path/to/repository \
  plan trace <work-id> \
  --run <run-id> \
  --input /absolute/path/outside/repository/plan-trace.json

codepatrol --workspace /absolute/path/to/repository \
  plan complete <work-id> \
  --run <run-id> \
  --result /absolute/path/outside/repository/plan-result.json
```

`start` and `resume` return a `schemaVersion: 1` handoff inline. Delete temporary control JSON after use. If optional publication fails, retry `codepatrol --workspace <main-repository-root> sync --work <work-id>`; never repeat completion.

Follow `docs/protocol.md` when available.
