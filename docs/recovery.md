# Recovery

Every refusal is designed to be recoverable, because a refused command has usually already committed something. When Codepatrol fails, it reports:

```json
{
  "error": "VERIFY_STALE",
  "message": "The base changed after Verify; refresh and verify the Change again.",
  "recovery": {
    "expected": "base <commit> and baseline <commit>",
    "observed": "base <commit> and baseline <commit>",
    "committed": ["the Change and its verification are intact; the base was not moved"],
    "nextCommand": "codepatrol change refresh <work-id>"
  }
}
```

Read `committed` before doing anything. It names the local facts the failure did **not** undo. Repeating a command whose effect already landed is the one dangerous move.

## First moves, always safe

```bash
codepatrol --workspace "$PWD" work graph          # the whole backlog and its statuses
codepatrol --workspace "$PWD" work show <work-id> # lifecycle, blockers, provenance
codepatrol --workspace "$PWD" change show <work-id>
codepatrol --workspace "$PWD" change diff <work-id>
```

All four are read-only.

## By situation

### A run was interrupted, or its response was lost

`resume` returns the same run with a freshly derived handoff. It never starts a second attempt.

```bash
codepatrol --workspace "$PWD" <stage> resume <work-id>
```

### A completion was refused after the manifest was written

`RESULT_CONFLICT` means the run was already completed with a **different** result. The recorded result stands. Re-submitting the identical result is safe and idempotent — that is how an interrupted Ship finishes its integration.

### `VERIFY_STALE` — the base moved

The candidate is intact; the base moved under it.

```bash
codepatrol --workspace "$PWD" change refresh <work-id>
```

Refresh merges the current base into the Change non-destructively, computes conflicts before moving any ref, and invalidates the standing Verify. Verify again afterwards.

### `VERIFY_INCOMPLETE` — a required command has no fresh evidence

The Verify run is still active. Run the commands `.codepatrol/policy.json` requires, record each with `verify trace`, then complete.

### `WORK_BLOCKED` — Build refused

Nothing was started. The blocker must reach `accepted`; rolled-back, superseded, and cancelled blockers never release a dependent. `work show <blocker>` says where it stands.

### `GIT_DIRTY` — the Change worktree has pending files

Build, Verify, and Ship-accept require a clean Change worktree. Commit the intended product files in the worktree, or discard them. The stage run stays active; complete it afterwards.

### `RESERVED_PATH` — a commit touched `.codepatrol/**`

A Change may carry its own manifest projection and nothing else under `.codepatrol/`; another Work's ledger or the runtime is refused. The offending paths are named. Remove them from the Change history and complete the stage again.

### `DOCUMENT_REJECTED` — the graph moved, or the document is illegal

Nothing was applied. `[STALE_DOCUMENT]` means re-inspect and propose again; do not edit the digest. Any other code lists every problem at once, each naming the Work it is about.

```bash
codepatrol --workspace "$PWD" spec inspect
```

### `STATE_CONFLICT` — a ref moved during a write

Codepatrol uses compare-and-swap on every ref it writes, so a conflicting write is refused rather than applied over. Re-read with `work show` and retry.

### Publication failed

Local state is intact and authoritative; publication is a projection that runs after the fact. Retry it directly — never repeat a lifecycle command to trigger it.

```bash
codepatrol --workspace "$PWD" sync --work <work-id>
```

### A Ship was interrupted between the decision and the integration

Re-run `ship complete` with the identical result. The manifest is the record; re-running finishes the integration rather than being refused as already terminal, and creates no duplicate squash commit.

## What is always recoverable from

- **An accepted Work** — its code history is at `refs/heads/codepatrol/archive/<work-id>` when it had code, its manifest lives on `refs/codepatrol/manifest/<work-id>`, and its final state also reached the base through the squash.
- **A rolled-back, superseded, or cancelled Work** — its manifest ref always remains; its archive ref too, when it had code. A Work that never had content is fully readable from the manifest ref alone.
- **Commits left on a Change branch after it was finalized** — kept at `refs/heads/codepatrol/recovery/<work-id>/<short-commit>` rather than deleted with the branch.
- **A lost worktree** — worktrees are disposable. `work checkout <work-id>` recreates one.
- **A lost handoff or control file** — regenerable. `resume` derives a fresh handoff from the manifest.
