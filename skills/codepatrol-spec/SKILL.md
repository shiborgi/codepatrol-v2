---
name: codepatrol-spec
description: Interpret an intent or the repository, and write the Initiative document that creates and shapes Works. The only way Works are created or restructured.
---

# Codepatrol Spec

Use `codepatrol` from `PATH`, with `node bin/codepatrol.js` as the in-repository fallback. Always pass the absolute main repository root with `--workspace`.

Spec is not a Work, a stage, a branch, or an Issue. It is the reasoning that turns intent into an **Initiative**: the Works, their dependencies, and the rationale for the shape. You propose; the Core validates and applies. You must never write `work.json`, Git refs, Change branches, Issue state, Project state, or anything under `.codepatrol/**`.

## Cycle

```bash
codepatrol --workspace /absolute/path/to/repository spec inspect
# reason, then write the Initiative document to an absolute path outside the repository
codepatrol --workspace /absolute/path/to/repository spec validate --initiative /absolute/path/outside/repository/document.json
codepatrol --workspace /absolute/path/to/repository spec apply    --initiative /absolute/path/outside/repository/document.json
```

`validate` is a dry run and mutates nothing. `apply` is all-or-nothing. Report the dry-run shape and obtain explicit user approval before `apply` whenever the document supersedes or cancels anything.

`spec inspect` returns the graph, each Work's derived status, the executable frontier, live runs, stale baselines, and a `digest`. Copy that `digest` into the document verbatim. If the graph moves before you apply, the Core rejects the document as stale — re-inspect and propose again rather than editing the digest.

## The Initiative document

One declarative document describes what the Initiative contains; the Core diffs it against the current graph and applies the difference atomically. Creating, updating, and rewiring are what the diff computes — the document states the final shape. Only what destroys standing Work is explicit: `cancel`, `supersede`, and `followUp`, each requiring an `authority`; ask the user for it rather than inventing one.

A Work the document no longer declares is dropped silently only while it has no content; with content behind it, the document is refused until you cancel or supersede that Work explicitly.

Write the document to an absolute path **outside** the repository and every worktree, and delete it afterwards.

```json
{
  "schemaVersion": 1,
  "type": "codepatrol-initiative-document",
  "documentId": "document-9f73",
  "intent": "Add passkey authentication",
  "summary": "Two Works: schema, then endpoint",
  "observedState": "Empty backlog; base at trunk; no active runs",
  "digest": "<the digest from spec inspect, verbatim>",
  "createdAt": "2026-08-01T12:00:00.000Z",
  "initiative": {
    "title": "Passkey authentication",
    "intent": "Replace password login with passkeys",
    "motivation": "Split by verification boundary: schema, then endpoint",
    "ordering": "The endpoint depends on the schema it persists into"
  },
  "works": [
    {
      "key": "schema",
      "title": "Add the credential schema",
      "description": "Persist public keys and sign counts",
      "issueType": "Feature",
      "priority": "p1",
      "acceptance": ["A credential round-trips through the store", "Migrations apply to an empty database"]
    },
    {
      "key": "endpoint",
      "title": "Add the registration endpoint",
      "description": "Accept an attestation and persist a credential",
      "issueType": "Feature",
      "priority": "p1",
      "acceptance": ["A valid attestation is stored", "An invalid attestation is rejected"],
      "blockedBy": ["#schema"]
    }
  ]
}
```

- `initiative` mints a new Initiative; omit it to add Works to the latest existing one. Its `motivation` records why the demand was split this way, and `ordering` the rationale for the attack order.
- A Work declared with `key` is created; one declared with `id` is updated where it differs. An existing Work must be declared in full — the document states the shape, not a patch.
- `#key` names a Work this same document creates; anything else must be an existing Work ID. Keys never survive application.
- `followUp` entries create Works that name the Work they came out of (`from`), which may be terminal.
- Acceptance criteria are what Verify reports against, so state observable outcomes, not a restatement of the description.

## Modes

1. **Intent** — the user described a problem, change, or outcome. Understand it, inspect the repository, inspect the graph, detect duplicate or overlapping scope, identify constraints and risks, formalize outcomes, define acceptance criteria, choose Work boundaries, and write the Initiative document.
2. **Discovery** — no intent given. Inspect active Works, the blocked and executable frontier, priorities, failing local tests, documentation drift, architectural inconsistencies, TODO and FIXME markers, duplicate implementations, outdated baselines, oversized Works, missing dependencies, and unresolved follow-ups. Propose what is most valuable next, with the evidence you found.
3. **Next** — recommend one Work to execute, weighing priority, dependency resolution, lifecycle state, baseline freshness, risk, conflicts with active Changes, and integration order. The graph's waves say what could run together; report them rather than starting anything.
4. **Refinement** — a named Work needs a clearer title or description, stronger acceptance criteria, a different priority, or changed dependencies: declare its final shape in the document.
5. **Backlog review** — analyze the whole graph for missing dependencies, invalid ordering, duplicate scope, oversized Works, unnecessary Works, stale or superseded Works, priority inconsistencies, and the executable frontier.
6. **External input** — an Issue or a CI failure is the source. Read it yourself (`gh issue view <n>`, CI logs); it is input only. Local Git state remains authoritative. Preserve the link by setting `requestedBy` to `github:<owner>/<name>#<number>` on the created Work, so publication maps the Work to that Issue instead of opening a second one.

## Work sizing

Create the smallest independently verifiable and integrable Works. Each should have one primary objective, one coherent Change, explicit acceptance criteria, bounded repository scope, a clear verification strategy, and no hidden independently deliverable sub-feature.

Split when parts can integrate independently, risks need separate verification, one part blocks another, rollout should be incremental, concerns are unrelated, or rollback boundaries differ. Do not fragment when changes are inseparable, when separate integration would leave the repository invalid, when the overhead exceeds the risk reduction, or when one behaviour and one verification boundary already cover the whole change.

## What you may change, and when

| Where the Work stands | What the document may do |
|---|---|
| Not started | Anything: rename, reprioritize, rewrite, rewire, supersede, cancel, drop |
| Plan or Review | Refinement, with the affected results explicitly invalidated; supersede, cancel |
| Build or Verify | No rewrite. Only a follow-up, supersede, or authorized cancellation |
| Terminal | Nothing. Only new follow-up, corrective, or successor Works that reference it |

A Work with a live run cannot be refined; complete or return the run first. Cancelling one is still permitted — its attempt is recorded as `abandoned`, keeping the evidence without ever counting as a result.

Only an **accepted** blocker releases its dependents. A rolled-back, superseded, or cancelled blocker does not, and never silently unblocks anything.

## Reporting

Report the dry-run shape, the Work IDs the application created or changed, the waves and what could run in parallel, and the exact next command. Never claim a Work exists before `apply` returned its ID. Name the acceptance criteria you chose and the boundaries you rejected, so the user can correct the shape before any Work is executed.

Follow `docs/protocol.md` when available.
