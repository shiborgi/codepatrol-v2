---
name: codepatrol-verify
description: Independently verify the exact Build candidate with minimum evidence, continue to Ship, or return to Build or Plan.
---

# Codepatrol Verify

Use `codepatrol` from `PATH`, with `node bin/codepatrol.js` as the in-repository fallback. Use the truthful harness and model supplied by the adapter. Always pass the absolute main repository root with `--workspace`.

1. Resolve exactly one explicit Work ID and require Verify ready or an active Verify run. Never select by recency.
2. Inspect Work and Change through the CLI and v1 handoff. Never read or modify `.codepatrol/**`.
3. Create a verification todo in an absolute temporary JSON file outside the repository and all worktrees. Mirror it in the harness task facility.
4. Start when ready. Resume the same run ID after interruption; never start a duplicate attempt.
5. Pin and report the active attempt's `verificationTarget.candidateCommit` and `verificationTarget.baselineCommit`. Verify exactly that range, not `inspection.headCommit`, a moving branch tip, or pending worktree content.
6. Do not edit, format, commit, rebase, or refresh the candidate. If implementation must change, return to Build. If the premise, scope, or acceptance contract must change, return to Plan. Verify has no other return target.
7. Inspect every changed file and the relevant blast radius. Execute acceptance and regression checks appropriate to the Change.
8. Run every command the repository requires. `.codepatrol/policy.json` declares `verify.requiredCommands` as exact argument arrays; each one needs a trace from **this** run with a matching command and `exitCode: 0`. `npm run verify` does not satisfy a policy requiring `npm run verify -- --ci`, and evidence from an earlier attempt never carries over. Completion is refused with `VERIFY_INCOMPLETE` and names what is missing.
9. Record minimum evidence: baseline and candidate hashes, each acceptance-criterion outcome, changed-file/diff inspection, relevant commands and outcomes, and untested areas or residual risk. Use trace input for concise evidence; do not commit logs as artifacts.
10. Continue only if the candidate is clean, acceptance is demonstrated, and the evidence is complete. Completion atomically records the attempt, `candidateCommit`, `baselineCommit`, `targetCommit`, and the `policyHash` the verification was made under.
11. Answer all starting todo IDs in order. Report the verdict, exact candidate, evidence, and next command without invoking Ship.

Use complete command forms. Every JSON path is absolute and outside the repository and its worktrees:

```bash
codepatrol --workspace /absolute/path/to/repository \
  verify start <work-id> \
  --harness <harness> \
  --model <model> \
  --todo /absolute/path/outside/repository/verify-todo.json

codepatrol --workspace /absolute/path/to/repository \
  verify resume <work-id>

codepatrol --workspace /absolute/path/to/repository \
  verify trace <work-id> \
  --run <run-id> \
  --input /absolute/path/outside/repository/verify-trace.json

codepatrol --workspace /absolute/path/to/repository \
  verify complete <work-id> \
  --run <run-id> \
  --result /absolute/path/outside/repository/verify-result.json
```

`start` and `resume` return a `schemaVersion: 1` handoff inline. Delete temporary control JSON after use. Retry optional publication with `codepatrol --workspace <main-repository-root> sync --work <work-id>` rather than repeating completion.

Follow `docs/protocol.md` when available.
