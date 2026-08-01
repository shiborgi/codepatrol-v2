---
name: codepatrol-ship
description: Inspect the exact verified candidate and record an explicitly authorized accept or rollback decision.
---

# Codepatrol Ship

Use `codepatrol` from `PATH`, with `node bin/codepatrol.js` as the in-repository fallback. Use the truthful harness and model supplied by the adapter. Always pass the absolute main repository root with `--workspace`.

1. Resolve exactly one explicit Work ID and require Ship ready or an active Ship run. Never select by recency.
2. Require explicit authority and an explicit `accept` or `rollback` instruction. Ask rather than infer either value.
3. Inspect Work and Change through CLI responses only. Never read or modify `.codepatrol/**`.
4. Create a Ship todo in an absolute temporary JSON file outside the repository and all worktrees. Mirror it in the harness task facility.
5. Start when ready. Resume the same run ID after interruption; never start a duplicate attempt.
6. Use the v1 handoff's canonical read-only `inspection` together with `change.verification`. They include baseline, candidate and target commits, commits, changed files, diff summary, attempts, returns, and evidence. Do not edit or refresh the Change.
7. Confirm that the inspection is clean, the base target still matches the verification snapshot, only canonical manifest checkpoints follow `candidateCommit`, and minimum Verify evidence is present.
8. Trace the terminal rationale. Complete with `accept` or `rollback` and the explicit authority. Ship has no return decision.
9. On accept, confirm the single integration commit on the base. On rollback, confirm that the base received no commit. Report the terminal outcome and archive ref.
10. If an Issue is linked only after Ship, `sync` records that late terminal link in the archived manifest; it does not rewrite the accepted base commit.

Use complete command forms. Every JSON path is absolute and outside the repository and its worktrees:

## What Ship records

A Work ends exactly once. Ship contributes a decision and an authority, nothing more: the attempts, traces, results, and artifacts the Work recorded while it ran are already its evidence, and nothing extra is built on top of them. Do not restate the evidence in the summary; cite it instead of reproducing it.

Never paste command output, logs, or environment contents into the summary. The manifest reaches the base branch and GitHub; the evidence is already recorded, so reference it rather than copying it.


```bash
codepatrol --workspace /absolute/path/to/repository \
  ship start <work-id> \
  --harness <harness> \
  --model <model> \
  --todo /absolute/path/outside/repository/ship-todo.json

codepatrol --workspace /absolute/path/to/repository \
  ship resume <work-id>

codepatrol --workspace /absolute/path/to/repository \
  ship trace <work-id> \
  --run <run-id> \
  --input /absolute/path/outside/repository/ship-trace.json

codepatrol --workspace /absolute/path/to/repository \
  ship complete <work-id> \
  --run <run-id> \
  --result /absolute/path/outside/repository/ship-result.json
```

`start` and `resume` return a `schemaVersion: 1` handoff inline. Delete temporary control JSON after use. Both outcomes preserve full Change history at `refs/heads/codepatrol/archive/<work-id>` and remove the open Change branch and linked worktree. Retry optional publication with `codepatrol --workspace <main-repository-root> sync --work <work-id>` rather than repeating completion.

Follow `docs/protocol.md` when available.
