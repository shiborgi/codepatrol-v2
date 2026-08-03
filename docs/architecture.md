# Architecture

## Goal

Codepatrol coordinates distinct planning, review, implementation, verification, and terminal-decision roles while retaining a local, auditable record. A Work describes the demand and lifecycle. A Change is the branch-backed product candidate created for that Work.

## Entry

The user never creates or restructures a Work directly. Intent enters through Spec, which reasons and proposes; the Core validates and applies.

```text
intent or repository
        |
   Spec skill                  reasoning: reads the graph, proposes
        |
  Initiative document          transient, dry-run by default, non-authoritative
        |
   Core validation             graph rules, lifecycle rules, staleness
        |
 atomic graph mutation         one ref transaction: all of it, or none
        |
  Work(s) + dependencies
```

This split is the reason the CLI contains no model: reasoning about an intent belongs to a skill, and deciding whether a document is legal belongs to code that can be tested exhaustively. A document carries the digest of the graph it was written against, so one written against a state that has since moved is refused rather than applied to a graph its author never saw.

Applying is one `git update-ref --stdin` transaction. Several Works, their manifest refs, and their edges land together; a document is never half-applied, because a half-applied graph is one nobody proposed and nobody can reason about.

## Sources Of Truth

```text
v1 Work manifest + local Git refs
               |
               +-> derived Work, Change, graph, handoff, and inspection views
               |
                +-> optional GitHub Issue, type label, Project status
```

The v1 manifest and Git objects are authoritative. A handoff is a derived execution view, not another store. GitHub is a one-way, retryable publication surface and is never required for a transition.

The local Work owns `issueType`; only `Bug`, `Feature`, and `Task` are valid. Publication projects that value through namespaced GitHub labels (`codepatrol:type/bug`, `codepatrol:type/feature`, `codepatrol:type/task`) and a managed section in the Issue body — never through GitHub native Issue Types, which are not available on every repository. Missing managed labels are created idempotently; when label management is unavailable the Issue is still created, the type stays visible in the body, and sync records a warning and retries later. It also maps local status to `Backlog`, `Plan`, `Review`, `Build`, `Verify`, or `Ship`. Remote edits cannot silently change local facts.

## Dependency Graph

Dependency edges live on the dependent's manifest, never on the blocker. Adding or removing one writes exactly one manifest, and a blocker — usually already terminal, and therefore immutable — never has to be reopened. The graph is the union of what each Work says about itself; there is no second ledger to disagree with it.

Only an **accepted** blocker releases its dependents. Rolled back, superseded, and cancelled are all terminal, and none of them delivered anything to the base, so none of them unblocks. A blocker that is not present locally is unresolved by definition: local manifests are the only authority on dependency state.

Plan and Review run while blocked, because understanding and reviewing a change does not depend on its blocker having landed. Build does not: its result is a candidate that would be verified against a base the blocker has not reached.

Cycles are refused over a plain edge map rather than over manifests, which is what lets a proposed graph — including Works that do not exist yet — be checked before any of it is written.

## Lifecycle

Work creation records `Backlog` before any Plan attempt. Forward transitions are Plan to Review, Review to Build, Build to Verify, and Verify to Ship. Return edges are deliberately narrow:

```text
Review -> Plan
Build  -> Plan
Verify -> Build | Plan
```

A return invalidates standing conclusions from its destination forward. This prevents an old approval or verification result from surviving changed premises or implementation.

## Git Model

A Work stops being a branch. The manifest lives on its own ref — `refs/codepatrol/manifest/<work-id>` — created by Spec, always present, and the only authority on the Work. A branch materializes on the first stage run of the Work, cut from the base as it stands at that moment, with `createdFromCommit` and `baselineCommit` recorded at the cut. Every stage start attaches the Work's own worktree at `.codepatrol/runtime/worktrees/<work-id>` and returns it as `worktreeDirectory`, so a stage run never shares the repository's main checkout with another Work. A backlog Work that has never started owns no branch and no worktree; creation still materializes nothing. When the branch opens, the manifest is also projected into the base; that copy is a projection, and disagreement with the ref is reported rather than merged.

1. Work creation writes the manifest to its ref and creates no branch and no worktree.
2. `change refresh` is allowed while a Work is ready, non-terminal, and has a branch. It computes conflicts first, merges the current base non-destructively, atomically checkpoints the new baseline, and invalidates a standing Verify. A branchless Work has no baseline to drift from.
3. Every stage start attaches the Work's own worktree, so Plan and Review run against the Work's checkout rather than the main repository. The first stage run materializes the Change branch and projects the manifest into the base; a backlog Work that has never started remains branchless.
4. Build edits only in the isolated Change worktree. Successful completion requires intended product files to be committed and the worktree to be clean.
5. Verify reads `baselineCommit..head`. It does not edit files. Continuing records the exact candidate commit, the manifest commit it was bound to, the baseline, and the target base commit.
6. Ship receives the current inspection, lifecycle history, and standing verification snapshot. Accept checks base freshness and permits only canonical manifest checkpoints after the verified candidate.
7. Accept creates exactly one squash commit on the base, carrying the manifest's final state. Rollback creates none. Both pin the same commit the working branch held at `refs/heads/codepatrol/archive/<work-id>` and remove the open Change branch and linked worktree; a terminal Work has exactly one branch, or none when it never had content.
8. A Spec decision — supersede or cancel — is also terminal, and also archives and removes the Change branch when one exists, but never touches the base. A run that was live when it landed is recorded as `abandoned`: its evidence stays readable and it never counts as a conclusion.

If the base moves after the frozen baseline, integration computes the candidate against the current target and refuses conflicts without partially mutating the base.

## Data Boundaries

### Product Artifacts

Product artifacts are files intentionally delivered by the Change. They live outside `.codepatrol`, are committed on the Change branch, and are identified in results by repository-relative path, kind, and recorded blob identity.

### Traces And Evidence

Traces record meaningful commands, observations, outcomes, and rationale. Evidence belongs in trace/result data and the manifest attempt record. Temporary todo, trace, and result JSON is command input, not product content, and must use absolute paths outside the repository and every worktree.

### Orchestration State

The manifest, active-run state, locks, and regenerable caches are orchestration state under `.codepatrol/**` or Codepatrol-owned refs. Only the CLI may access them. Executors must not directly read, write, stage, commit, or delete `.codepatrol/**`; they consume CLI views and submit control JSON through commands.

This boundary prevents implementation commits from accidentally carrying orchestration internals and prevents an executor from manufacturing lifecycle facts.

## Schema Boundary

The manifest and handoff independently declare `schemaVersion: 1`. The manifest and executor-input parsers reject unknown versions or fields; the typed handoff is produced only by Codepatrol. It is regenerated from the manifest and Git inspection whenever a run starts or resumes.

Todo, trace, and result documents are executor inputs. They do not become alternate state stores. A result answers exactly the todo IDs declared at start, in the same order.

## Execution Identity

The core fixes each stage's role. A harness adapter supplies the truthful `harness` and `model` to `start`; it never copies lifecycle policy. `resume` discovers the stage's active run and cannot alter its role, harness, model, todo, or attempt number.

## Candidate Integrity

Verify records an exact candidate checkpoint, compares it with the operational baseline, and supplies minimum evidence. Ship permits later canonical manifest checkpoints but refuses any other post-Verify path or a changed base target.

Command output is evidence, and evidence outlives the run: the manifest reaches the base branch through the accept squash and is then pushed. So the manifest keeps a bounded, redacted tail plus a digest of the full output, and the untouched output goes to the disposable runtime. The digest still identifies exactly which bytes were produced without carrying them.

The repository states what verification means at `.codepatrol/policy.json`. Required commands are argument arrays compared exactly, and each needs a successful trace from the Verify run being completed — evidence from an earlier attempt proves nothing about this candidate. A Change cannot relax the rules it is judged by, because `.codepatrol/**` is reserved to Codepatrol; the policy in the candidate is necessarily the one the repository owner committed.

## Terminal Evidence

A Work leaves behind exactly what it recorded while it ran — its attempts, traces, results, and artifacts — and its outcome in `completion`. Nothing extra is built on top of it: Ship contributes a decision and an authority, nothing more. There is no separate retrospective record; the evidence a terminal Work already carries is the record.

Spec reads that terminal evidence directly, across the Works it names, to write the next Initiative. An improvement Initiative cites the Works and what they showed, in prose, the same way any Initiative states its motivation.

```text
Work execution → terminal evidence (canonical, in the terminal manifest)
              → Spec analysis
              → Initiative document
              → Core validation
              → explicit approval
              → new Works
```

The boundary is absolute: **self-improvement proposes and never applies.** Turning terminal evidence into a Work means a normal Initiative document, normal validation, and a human's approval. `WorkGraphService` remains the only structural writer, and a follow-up Work is validated, approved, and executed exactly like any other.

All four terminal outcomes — accepted, rolled back, superseded, cancelled — pass through one terminalization. Ship supplies the decision and its authority; a Spec decision supplies none, because a graph decision states no lesson of its own and inventing one would be fabrication.

## Publication And Recovery

Publication occurs after local state exists. Failure leaves local state intact and is retried with `sync` rather than repeating a lifecycle transition.

A terminal Work's remote branch is deleted only once its archive is confirmed and its Issue outcome is published. Cleanup that fails stays pending for the next `sync` and never reverts the local terminal outcome.

Refusals carry recovery: what was expected, what was observed, which local facts survived, and one safe next command. This matters most where a command has already committed a manifest checkpoint — the dangerous move there is to guess and repeat.

The manifest ref is the durable record of every Work; the archive ref is the durable audit record of its code, for both outcomes, when there was code. A Work can finish without any Issue and without any branch. When an Issue is linked after the Work is terminal, sync writes the association to the manifest ref; the archive is frozen at terminalization and is never advanced, rewritten, or deleted, and the accepted integration commit is never amended.

Open Work recovery uses the manifest ref and, where one exists, the Change branch. Active runs resume by stage, Work ID, and run ID. Terminal recovery reads the manifest ref and, for Works that had code, the archive ref. Regenerable handoffs and temporary executor control files are never recovery authorities.
