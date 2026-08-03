# Execution Protocol

## Work And Change

A Work is one typed demand. `work.issueType` is required and must be `Bug`, `Feature`, or `Task`. A newly created Work has status `Backlog`; Plan has not started yet. It lives on its manifest ref — `refs/codepatrol/manifest/<work-id>` — and owns no branch and no worktree: a branch materializes only when something needs one, cut from the base as it stands at that moment.

The lifecycle is:

```text
Backlog -> Plan -> Review -> Build -> Verify -> Ship
Review -> Plan
Build  -> Plan
Verify -> Build | Plan
```

No other return target is valid.

## Manifest V1

The durable Work manifest uses `schemaVersion: 1`. This is the normative top-level shape; omitted nullable values are represented as `null`, not invented by an executor. Unknown fields are rejected rather than dropped: a misspelled key means the writer asked for something other than what it believes it asked for.

`work.initiative` names the Initiative the Work belongs to — its id and the Work's position inside it, both minted at creation and never changed. `work.origin` records when the Work was created and, for follow-ups, the Work it came out of. `work.acceptance` states what must be demonstrably true for the Work to be accepted; Verify reports against it. `graph.blockedBy` holds this Work's outgoing dependency edges, sorted and unique.

```json
{
  "schemaVersion": 1,
  "type": "codepatrol-work",
  "work": {
    "id": "INIT-0.1-add-credential-schema",
    "title": "Add the credential schema",
    "description": "Persist public keys and signature counters",
    "issueType": "Feature",
    "priority": "p1",
    "acceptance": [
      "A credential round-trips through the store",
      "Migrations apply to an empty database"
    ],
    "createdAt": "2026-08-01T12:00:00.000Z",
    "requestedBy": "spec",
    "initiative": {
      "id": "INIT-0",
      "position": 1
    },
    "origin": {
      "createdAt": "2026-08-01T12:00:00.000Z"
    }
  },
  "repository": {
    "baseRef": "refs/heads/main"
  },
  "graph": { "blockedBy": [] },
  "issue": null,
  "workflow": {
    "state": "ready",
    "stage": "plan",
    "attempt": 1,
    "updatedAt": "2026-08-01T12:00:00.000Z"
  },
  "attempts": [],
  "completion": null
}
```

Codepatrol alone reads and writes the manifest. Executors must not access `.codepatrol/**` directly. Manifest commits and Codepatrol-owned refs form orchestration history; product commits must not modify those paths.

## Initiative Document

Works are created and restructured only by applying an Initiative document: one declarative description of what the Initiative contains, diffed against the current graph and applied atomically. The document uses `schemaVersion: 1` and is parsed as strictly as the manifest.

```json
{
  "schemaVersion": 1,
  "type": "codepatrol-initiative-document",
  "documentId": "document-9f73",
  "intent": "Add passkey authentication",
  "summary": "Two Works: credential schema, then registration endpoint",
  "observedState": "Empty backlog; base at main; no active runs",
  "digest": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
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
      "description": "Persist public keys and signature counters",
      "issueType": "Feature",
      "priority": "p1",
      "acceptance": ["A credential round-trips through the store"]
    },
    {
      "key": "endpoint",
      "title": "Add the registration endpoint",
      "description": "Accept an attestation and persist a credential",
      "issueType": "Feature",
      "priority": "p1",
      "acceptance": ["A valid attestation is stored"],
      "blockedBy": ["#schema"]
    }
  ]
}
```

`digest` is the fingerprint returned by `spec inspect`, copied verbatim. A document whose digest no longer matches the graph is refused as stale: it reasons about a state its author never saw. `#key` names a Work this same document creates; anything else must be an existing Work ID. Keys never survive application.

Creating, updating, and rewiring are what the diff computes: a Work declared with `key` is created, one declared with `id` is updated where it differs, and a declared `blockedBy` replaces the current edge set. A Work of the Initiative the document no longer declares is dropped silently only while content-free; with content it must be ended explicitly. Only what destroys standing Work stays in the document — `cancel`, `supersede`, and `followUp` — and each requires an explicit `authority`.

Application is atomic: every Work's manifest ref and every edge lands in one Git ref transaction, or none does.

```bash
codepatrol --workspace /absolute/path/to/repository spec inspect
codepatrol --workspace /absolute/path/to/repository spec validate --initiative /absolute/path/outside/repository/document.json
codepatrol --workspace /absolute/path/to/repository spec apply    --initiative /absolute/path/outside/repository/document.json
```

`validate` is a dry run and mutates nothing.

## Dependencies

`graph.blockedBy` names the Works that block this one. Only an **accepted** blocker releases its dependents; rolled back, superseded, and cancelled do not, and neither does a blocker that is not present locally. Plan and Review run while blocked. Build is refused with `WORK_BLOCKED` until every blocker is accepted. Direct and transitive cycles are rejected, including ones that would only exist once a document's new Works land.

## Terminal Outcomes

| Outcome | Decided by | Effect on the base |
|---|---|---|
| `accepted` | Ship | Exactly one squash commit |
| `rolled-back` | Ship | None |
| `superseded` | Spec | None; records `replacedBy` |
| `cancelled` | Spec | None; records the reason as its summary |

All four terminalize the Work on its manifest ref. When the Work had a branch, its commit is pinned at `refs/heads/codepatrol/archive/<work-id>` and the open branch is removed; a Work that never had content ends with its manifest ref alone. A run that was live when Spec ended the Work becomes `abandoned`: it has a `finishedAt` and no `result`, so its evidence survives without ever reading as a conclusion.

## Terminal Evidence

A terminal Work leaves behind exactly what it already recorded: its attempts, their traces, results, and artifacts, and the outcome in `completion`. There is no second record built on top of it — Ship contributes a decision and an authority, nothing more. Reading what a Work, or an Initiative's terminal Works, actually did is `work show` and `initiative show`; nothing is aggregated or stored beyond the manifest.

Command traces record a SHA-256 of each stream, its byte count, and how many credential shapes were redacted — and, by default, no output. `verify.persistOutputExcerpt` opts in to a bounded, redacted tail. The full output is always written to `.codepatrol/runtime/`, outside Git.

## Baseline And Refresh

`createdFromCommit` and `baselineCommit` are absent while a Work has no branch. Both are recorded when the branch is cut, from the base as it stands then: `createdFromCommit` is immutable provenance, and `baselineCommit` is the operational base snapshot used for inspection and verification. A ready, non-terminal Work with a branch and no active run may be refreshed onto the current base tip:

```bash
codepatrol --workspace /absolute/path/to/repository change refresh <work-id>
```

Refresh computes conflicts before moving refs, creates a non-destructive merge into the Change, and atomically checkpoints the new baseline. It is refused while a run is active or after terminality. Refresh after a standing Verify invalidates that Verify and makes Verify the next stage again.

## Starting And Resuming

Todo JSON is a non-empty array with unique IDs:

```json
[
  {
    "id": "T1",
    "title": "Inspect acceptance and relevant context",
    "description": "Record evidence for the role's decision"
  }
]
```

Every stage uses the same complete command forms. All JSON paths are absolute and outside the repository and its worktrees.

```bash
codepatrol --workspace /absolute/path/to/repository \
  <stage> start <work-id> \
  --harness <harness> \
  --model <model> \
  --todo /absolute/path/outside/repository/todo.json

codepatrol --workspace /absolute/path/to/repository \
  <stage> resume <work-id>

codepatrol --workspace /absolute/path/to/repository \
  <stage> trace <work-id> \
  --run <run-id> \
  --input /absolute/path/outside/repository/trace.json

codepatrol --workspace /absolute/path/to/repository \
  <stage> complete <work-id> \
  --run <run-id> \
  --result /absolute/path/outside/repository/result.json
```

`start` creates one attempt and returns its run ID and handoff. `resume` discovers the active run for that stage, returns the same attempt with a freshly derived handoff, and does not create another attempt. A harness restart or lost response is therefore recovered with `resume`, not a second `start`.

## Handoff V1

The start/resume response contains this derived handoff contract:

```json
{
  "schemaVersion": 1,
  "type": "codepatrol-handoff",
  "work": {
    "id": "<work-id>",
    "title": "<title>",
    "description": "<description>",
    "issueType": "Bug",
    "priority": "p1",
    "createdAt": "<ISO-8601>",
    "requestedBy": "<identity>"
  },
  "issue": null,
  "run": {
    "id": "<run-id>",
    "stage": "plan",
    "attempt": 1,
    "role": "planner",
    "harness": "opencode",
    "model": "<model>",
    "startedAt": "<ISO-8601>",
    "todo": [
      { "id": "T1", "title": "Produce the Plan result" }
    ]
  },
  "repository": {
    "baseRef": "refs/heads/<base>",
    "branch": "refs/heads/codepatrol/work/<work-id>",
    "createdFromCommit": "<git-commit>",
    "manifestPath": ".codepatrol/works/<work-id>/work.json",
    "inspectionRef": "refs/heads/codepatrol/work/<work-id>",
    "worktreeDirectory": "<absolute-path>/.codepatrol/runtime/worktrees/<work-id>",
    "baselineCommit": "<git-commit>"
  },
  "change": {
    "workId": "<work-id>",
    "branch": "refs/heads/codepatrol/work/<work-id>",
    "baseRef": "refs/heads/<base>",
    "archiveRef": "refs/heads/codepatrol/archive/<work-id>",
    "state": "draft",
    "review": null,
    "checks": null,
    "verification": null
  },
  "inspection": {
    "createdFromCommit": "<git-commit>",
    "baselineCommit": "<git-commit>",
    "headCommit": "<git-commit>",
    "targetCommit": "<git-commit>",
    "baselineStale": false,
    "clean": true,
    "status": [],
    "commits": [],
    "changedFiles": [],
    "diffStat": ""
  },
  "attempts": [
    {
      "stage": "plan",
      "attempt": 1,
      "runId": "<run-id>",
      "status": "active",
      "execution": {
        "role": "planner",
        "harness": "opencode",
        "model": "<model>"
      },
      "startedAt": "<ISO-8601>",
      "todo": [
        { "id": "T1", "title": "Produce the Plan result" }
      ]
    }
  ],
  "trigger": null,
  "availableResults": [],
  "returns": [],
  "pathPolicy": {
    "executorForbidden": [".codepatrol", ".codepatrol/**"],
    "artifactForbidden": [".codepatrol", ".codepatrol/**"]
  }
}
```

The same handoff is returned inline by `start`/`resume` and cached at `inputFile`; executors consume the inline value and do not read `.codepatrol/**`. Fields are stage-sensitive:

- Every stage start returns the Work's own worktree as `worktreeDirectory` — Plan and Review no longer run in the repository's main checkout. A backlog Work that has never started still owns no branch and no worktree; creation never materializes one.
- Build receives the isolated Change worktree and the frozen baseline.
- Verify uses the active attempt's `verificationTarget.candidateCommit` as the exact candidate. `inspection.headCommit` includes the later Verify-start manifest checkpoint and is not the candidate.
- Ship receives the current inspection plus the standing `change.verification` snapshot. It checks that commits after the verified candidate touch only the canonical manifest.

Every handoff includes the full attempt history. Active attempts omit `finishedAt`, `result`, and `traces`; Verify attempts additionally carry `verificationTarget`, and a successful completed Verify also carries the identical `verifiedCandidate`. A linked `issue` is `{ "repository": "owner/name", "number": 123 }` rather than `null`.

## Traces And Evidence

A trace contains a meaningful semantic fact:

```json
{
  "type": "command",
  "message": "Ran the focused validation",
  "command": ["npm", "test", "--", "authentication"],
  "exitCode": 0
}
```

Trace types are `observation`, `decision`, `action`, `error`, `metric`, or `command`. Command traces require a non-empty argument array and integer exit code. Do not include secrets, full environment dumps, or unrelated output.

Minimum Verify evidence identifies the baseline and exact candidate, reports every acceptance criterion, records changed-file/diff inspection, records relevant commands and outcomes, and names untested areas or residual risks. A bare pass decision is insufficient.

## Product Artifacts

An artifact is an intentional product file delivered with the Change, not todo/result/trace control JSON and not a command transcript. It must be committed on the Change branch and declared by repository-relative path:

```json
{
  "path": "docs/user-guide.md",
  "kind": "documentation",
  "description": "User-facing authentication behavior"
}
```

Codepatrol records the committed blob identity. Paths under `.codepatrol/**`, absolute paths, and paths escaping the repository are forbidden.

## Results

Every result answers exactly the starting todo IDs in the original order.

```json
{
  "decision": "continue",
  "summary": "Acceptance behavior is implemented",
  "handoff": "Verify candidate <commit> against baseline <commit>",
  "todo": [
    { "id": "T1", "status": "completed", "note": "Focused validation passed" }
  ],
  "artifacts": []
}
```

Todo status is `completed`, `skipped`, or `failed`.

A decision that carries the work forward — `continue` or `accept` — may not rest on a `failed` item: an item that was evaluated and not satisfied is what `return` and `rollback` exist for. A `skipped` item requires a non-empty `note`, because "not applicable" is a claim rather than an absence. Both rules are enforced by the lifecycle and re-checked when a manifest is parsed.

Plan may only continue. Review, Build, and Verify may continue or use one of their exact return edges. Ship may only accept or roll back and requires explicit authority.

```json
{
  "decision": "return",
  "returnTo": "plan",
  "reasons": ["The acceptance premise is incomplete"],
  "summary": "Plan revision required",
  "handoff": "Resolve the recorded scope defect",
  "todo": [
    { "id": "T1", "status": "completed" }
  ],
  "artifacts": []
}
```

```json
{
  "decision": "accept",
  "authority": "release-owner",
  "summary": "Verified candidate accepted",
  "handoff": "Lifecycle terminal",
  "todo": [
    { "id": "T1", "status": "completed" }
  ],
  "artifacts": []
}
```

## Verification Policy

A repository declares what Verify must actually run, at `.codepatrol/policy.json` on the base:

```json
{
  "verify": {
    "requiredCommands": [
      ["npm", "run", "verify"]
    ],
    "persistOutputExcerpt": false
  }
}
```

Commands are argument arrays, compared exactly: differing arguments are a different command. Each one must have a trace from the Verify run being completed, with `exitCode: 0`. Traces from an earlier attempt do not carry over. A missing command fails completion with `VERIFY_INCOMPLETE`, naming what was not run. A repository with no policy file requires nothing beyond the general Verify evidence rules.

The policy is reserved state: `.codepatrol/**` is forbidden to a Change, so a candidate cannot relax the rules it is judged by. Changing the policy is a commit by the repository owner, outside the Codepatrol flow.

## Candidate Rules

Verify does not edit, commit, rebase, or refresh the candidate. Verify continue atomically records its `attempt`, `candidateCommit`, `baselineCommit`, the observed base `targetCommit`, and the `policyHash` in force, so an archived manifest still states which rules its verification was made under.

Ship accept is refused if the base target or baseline changed, if any post-Verify commit touches a path other than the canonical manifest, or if the worktree is dirty. Rollback remains available.

## Publication And Archive

`sync` projects the local Work title, type label, managed body section, and status to a linked GitHub Issue and Project. The Work type is projected as a namespaced label (`codepatrol:type/bug`, `codepatrol:type/feature`, `codepatrol:type/task`); sync keeps exactly one managed type label, removes obsolete managed labels, and never touches user labels. When label management is unavailable the Issue is still synchronized, the type remains visible in the managed body section, and a warning is recorded for the next retry. A missing remote reports a skipped publication; a failure is retried without repeating start or complete.

Terminal Change history — when the Work had code — is retained at:

```text
refs/heads/codepatrol/archive/<work-id>
```

The archive is pinned once, at terminalization, and is never advanced, rewritten, or deleted afterwards. A Work may become terminal while `issue` is still `null`. If sync creates or links the Issue later, it writes `{repository, number}` into the manifest on the manifest ref; the archive and the accepted base commit remain unchanged.
