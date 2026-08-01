---
name: codepatrol-build
description: Implement one approved Plan in the Change worktree, establish the candidate commit, or return exactly to Plan.
---

# Codepatrol Build

Use `codepatrol` from `PATH`, with `node bin/codepatrol.js` as the in-repository fallback. Use the truthful harness and model supplied by the adapter. Always pass the absolute main repository root with `--workspace`.

1. Resolve exactly one explicit Work ID and require Build ready or an active Build run. Never select by recency.
2. Inspect Work, Change, approved Plan, and return history through the CLI and v1 handoff. Never read or modify `.codepatrol/**`.
3. Create a Build todo in an absolute temporary JSON file outside the repository and all worktrees. Mirror it in the harness task facility.
4. Start when ready. Resume with the active run ID after interruption; never start a duplicate attempt.
5. Perform every repository edit and repository command in the returned Change `worktreeDirectory`, while all Codepatrol commands continue to use the main root as `--workspace`.
6. Implement test-first where practical. Keep product changes in ordinary repository paths. Todo/result/trace files and command transcripts are control/evidence, not product artifacts, and must not enter the worktree.
7. Commit every intended product change on the Change branch. Declare only committed product files as artifacts. Record significant commands, outcomes, observations, and failures through `trace --input`.
8. Before continue, run relevant validation and require the Change worktree to be clean. Verify start will pin the resulting branch head as `candidateCommit`.
9. If the accepted Plan cannot be implemented as stated, return only to Plan with concrete reasons. Build must not return to Review.
10. Answer all starting todo IDs in order. Report changed files, commits, validation evidence, candidate commit, and exact next command without invoking Verify.

Use complete command forms. Every JSON path is absolute and outside the repository and its worktrees:

```bash
codepatrol --workspace /absolute/path/to/repository \
  build start <work-id> \
  --harness <harness> \
  --model <model> \
  --todo /absolute/path/outside/repository/build-todo.json

codepatrol --workspace /absolute/path/to/repository \
  build resume <work-id>

codepatrol --workspace /absolute/path/to/repository \
  build trace <work-id> \
  --run <run-id> \
  --input /absolute/path/outside/repository/build-trace.json

codepatrol --workspace /absolute/path/to/repository \
  build complete <work-id> \
  --run <run-id> \
  --result /absolute/path/outside/repository/build-result.json
```

`start` and `resume` return a `schemaVersion: 1` handoff inline. Delete temporary control JSON after use. Retry optional publication with `codepatrol --workspace <main-repository-root> sync --work <work-id>` rather than repeating completion.

Follow `docs/protocol.md` when available.
