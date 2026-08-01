---
name: codepatrol-review
description: Independently review one Plan handoff and continue to Build or return exactly to Plan.
---

# Codepatrol Review

Use `codepatrol` from `PATH`, with `node bin/codepatrol.js` as the in-repository fallback. Use the truthful harness and model supplied by the adapter. Always pass the absolute main repository root with `--workspace`.

1. Resolve exactly one explicit Work ID and require Review ready or an active Review run. Never select by recency.
2. Inspect Work and Change facts through the CLI and the v1 handoff. Never read or modify `.codepatrol/**`.
3. Create a review todo at an absolute temporary JSON path outside the repository and all worktrees. Mirror it in the harness task facility.
4. Start when ready. Resume with the existing run ID when active; never start a duplicate attempt.
5. Review the Plan's premises, scope, acceptance criteria, risk, proposed files, and validation strategy independently. Do not edit production code.
6. Submit concise command/decision evidence with `trace --input`. Temporary command JSON and review notes are not product artifacts.
7. Continue only when the Plan is executable and decision-complete. Otherwise use `decision: "return"`, `returnTo: "plan"`, and concrete reasons. Review has no other return target.
8. Answer all starting todo IDs in order, report the verdict and exact next command, and do not invoke the next stage.

Use complete command forms. Every JSON path is absolute and outside the repository and its worktrees:

```bash
codepatrol --workspace /absolute/path/to/repository \
  review start <work-id> \
  --harness <harness> \
  --model <model> \
  --todo /absolute/path/outside/repository/review-todo.json

codepatrol --workspace /absolute/path/to/repository \
  review resume <work-id>

codepatrol --workspace /absolute/path/to/repository \
  review trace <work-id> \
  --run <run-id> \
  --input /absolute/path/outside/repository/review-trace.json

codepatrol --workspace /absolute/path/to/repository \
  review complete <work-id> \
  --run <run-id> \
  --result /absolute/path/outside/repository/review-result.json
```

`start` and `resume` return a `schemaVersion: 1` handoff inline. Delete temporary control JSON after use. Retry optional publication with `codepatrol --workspace <main-repository-root> sync --work <work-id>` rather than repeating completion.

Follow `docs/protocol.md` when available.
