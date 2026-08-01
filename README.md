# Codepatrol

Codepatrol is a local-first, harness/model-agnostic orchestrator for agent-driven changes. A **Work** records one demand and its lifecycle. Its **Change** is the local branch-backed delivery candidate.

Git and the v1 Work manifest are authoritative. GitHub publication is optional: a Work may be linked to an Issue and projected onto a Project, but remote state never commands a transition and every lifecycle command works without a remote.

## Entry point

Works are never created or restructured by hand. Every one of them belongs to an **Initiative** — the intent behind a breakdown, why it splits the way it does, and the order to attack it. The `codepatrol-spec` skill reads an intent or the repository, writes an Initiative document declaring the Initiative and the Works it breaks into, and the Core validates and applies it atomically.

```text
intent or repository
        |
   Spec skill                      (reasoning: proposes)
        |
  Initiative document              (declarative, dry-run by default)
        |
   Core validation                 (graph and lifecycle rules)
        |
 atomic graph mutation             (the Initiative, its Works, and their edges, or none)
        |
  Initiative + Work(s) + dependencies
```

```bash
codepatrol spec inspect                                        # the graph, its statuses, and a digest
codepatrol initiative show <initiative-id>                     # one Initiative, its Works, and their order
codepatrol spec validate --initiative /absolute/document.json  # dry run; mutates nothing
codepatrol spec apply    --initiative /absolute/document.json  # one transaction
```

A document carries the digest of the graph it was written against, so one that no longer matches reality is refused rather than applied to a graph its author never saw. `examples/initiative.json` is a complete document.

## The loop closes

A Work leaves behind exactly what it recorded while it ran — its attempts, traces, results, and artifacts — and its outcome in `completion`. Nothing extra is built on top of it: Ship contributes a decision and an authority, nothing more. Spec reads that terminal evidence directly, across the Works it names, to write the next Initiative — an improvement Initiative cites the Works and what they showed, in prose, the same way any Initiative states its motivation.

The boundary is absolute: **self-improvement proposes and never applies.** Turning terminal evidence into a Work means a normal Initiative document, normal validation, and a human's approval.

## Lifecycle

```text
Backlog -> Plan -> Review -> Build -> Verify -> Ship
                     |         |         |
                     v         v         +-> Build or Plan
                    Plan      Plan
```

- A Work requires an Issue Type of `Bug`, `Feature`, or `Task` and explicit acceptance criteria, and records status `Backlog`. It lives on its manifest ref and owns no branch and no worktree: a branch materializes only when something needs one, cut from the base as it stands at that moment.
- Works may depend on each other. Plan and Review run while blocked; Build refuses to start until every blocker is **accepted**. A rolled-back, superseded, or cancelled blocker never releases its dependents. `codepatrol work graph` shows the whole graph and its executable frontier.
- `change refresh` non-destructively updates any ready, non-terminal Work with a branch to the current base tip. It refuses active runs and invalidates a standing Verify.
- Plan inspects the Work without a checkout by default. `--worktree` or `work checkout` materializes the Change branch and its isolated worktree when Plan genuinely needs one.
- Review may continue to Build or return only to Plan.
- Build may continue to Verify or return only to Plan. Completion requires a clean worktree.
- Verify examines the candidate head against the recorded baseline and target base. It may continue to Ship, return to Build for implementation defects, or return to Plan for premise or scope defects.
- Ship receives a read-only inspection of the verified candidate and lifecycle evidence. It does not edit or refresh the candidate. `accept` adds exactly one squash commit to the base; `rollback` adds none.

Each stage has one fixed role:

| Stage | Role |
|---|---|
| Plan | `planner` |
| Review | `reviewer` |
| Build | `builder` |
| Verify | `verifier` |
| Ship | `shipper` |

The orchestrator controls transitions and records structural facts. Executors provide semantic decisions and evidence and never invoke the next stage automatically.

## Installation

Requires Node.js 20 or later and Git. GitHub publication additionally requires an authenticated `gh` with access to the repository and Project.

```bash
npm install
npm run build
node bin/codepatrol.js --help
```

The workspace is always the main repository root, selected explicitly with `--workspace`. The base branch is resolved without assuming a branch name.

## CLI Protocol

Inspect Works and their graph. All reads are local and need no remote:

```bash
codepatrol --workspace /absolute/path/to/repository work list
codepatrol --workspace /absolute/path/to/repository work graph
codepatrol --workspace /absolute/path/to/repository work show <work-id>
codepatrol --workspace /absolute/path/to/repository change show <work-id>
codepatrol --workspace /absolute/path/to/repository change diff <work-id>
codepatrol --workspace /absolute/path/to/repository change refresh <work-id>
```

For every stage, write todo, trace, and result control JSON to absolute temporary paths outside the main repository and every linked worktree. Never put these command files in the Change or declare them as product artifacts.

```bash
codepatrol --workspace /absolute/path/to/repository \
  plan start <work-id> \
  --harness opencode \
  --model gpt-5 \
  --todo /absolute/path/outside/repository/todo.json

codepatrol --workspace /absolute/path/to/repository \
  plan resume <work-id>

codepatrol --workspace /absolute/path/to/repository \
  plan trace <work-id> \
  --run <run-id> \
  --input /absolute/path/outside/repository/trace.json

codepatrol --workspace /absolute/path/to/repository \
  plan complete <work-id> \
  --run <run-id> \
  --result /absolute/path/outside/repository/result.json
```

Replace `plan` with `review`, `build`, `verify`, or `ship`. `start` returns `runId`, the v1 handoff, the Change inspection ref, and the worktree directory when one exists. `resume` discovers and returns the same active run with a freshly derived v1 handoff; it never starts another attempt. Keep using the main repository root for `--workspace`, including while repository commands run in a Change worktree.

## Three Kinds Of Data

- **Product artifacts** are intentional files that belong in the delivered Change. They are committed on the Change branch and declared in a result by repository-relative path and kind.
- **Command traces and evidence** explain inspections, commands, outcomes, and decisions. Submit concise trace JSON with `trace --input`; do not commit logs or temporary control JSON merely to preserve evidence.
- **Orchestration state** is the v1 manifest, active-run metadata, locks, and caches managed only by Codepatrol. Executors must not read, write, stage, commit, or delete `.codepatrol/**`; use CLI responses and handoffs instead.

An artifact declaration is not a command log. Codepatrol accepts a product artifact only when its path is committed on the Change branch and records its blob identity.

## Candidate Evidence

Build completion must leave the Change worktree clean. Verify records the exact candidate, baseline, and target commits and, at minimum, records:

- the candidate and baseline commit identities;
- acceptance-criterion outcomes;
- the changed-file and diff review performed;
- relevant validation commands with their outcomes; and
- any untested area or residual risk.

Verify must not modify the candidate. A required implementation change returns to Build; an invalid premise, acceptance contract, or scope returns to Plan. Ship refuses changed base/baseline state and any post-Verify commit that touches more than the canonical manifest.

## Local-First GitHub Publication

The local Work's `issueType` is authoritative and is one of `Bug`, `Feature`, or `Task`. `sync` creates or links an Issue, projects that local value through namespaced GitHub labels (`codepatrol:type/bug`, `codepatrol:type/feature`, `codepatrol:type/task`) plus a managed section in the Issue body, and projects lifecycle status using exactly `Backlog`, `Plan`, `Review`, `Build`, `Verify`, and `Ship`. GitHub native Issue Types are not used. GitHub edits do not silently rewrite local type or lifecycle state.

```bash
codepatrol --workspace /absolute/path/to/repository sync --work <work-id>
```

Without a suitable remote, publication is skipped and local work continues. A failed publication is retried with `sync`; do not repeat a completed lifecycle command.

Both Ship outcomes preserve the Change's code at `refs/heads/codepatrol/archive/<work-id>` when the Work had code; the manifest ref carries the record in every case. If an Issue is first linked after Ship, `sync` records that late terminal link on the manifest ref. It does not rewrite the accepted base commit, and the frozen archive is never advanced or deleted.

## Skills

Harness-neutral policy lives under `skills/codepatrol-*/SKILL.md`. Harness adapters are thin entry points that supply only the truthful harness and model identity. Skills own selection, stage behavior, evidence, and decisions; adapters must not duplicate lifecycle policy or invoke the next stage.

## Documentation

| Document | What it covers |
|---|---|
| [`docs/installation.md`](docs/installation.md) | Requirements, install, first run, harness adapters |
| [`docs/protocol.md`](docs/protocol.md) | Normative manifest, handoff, Initiative document, result, evidence, and persistence contracts |
| [`docs/architecture.md`](docs/architecture.md) | Entry through Spec, the dependency graph, Git model, boundaries |
| [`docs/recovery.md`](docs/recovery.md) | What to do when a command is refused |
| [`docs/troubleshooting.md`](docs/troubleshooting.md) | Setup failures rather than state failures |
| [`docs/compatibility.md`](docs/compatibility.md) | What 1.x will not break, and how schemas are versioned |
| [`docs/upgrade.md`](docs/upgrade.md) | Upgrading, and what needs migrating (nothing) |
| [`docs/limitations.md`](docs/limitations.md) | Deliberate exclusions and unverified platforms |
| [`CHANGELOG.md`](CHANGELOG.md) | Release notes |

```bash
npm run verify
```
