---
name: codepatrol-work
description: List, select, and inspect local-first Codepatrol Works, their dependency graph, and their Changes.
---

# Codepatrol Work

Use `codepatrol` from `PATH`. Inside the Codepatrol repository only, fall back to `node bin/codepatrol.js` when the binary is unavailable. Always pass `--workspace <main-repository-root>` with an absolute path.

A Work is one typed demand. Its required `type` is exactly `Bug`, `Feature`, or `Task` and is its Issue Type. A new Work starts in `Backlog`; Plan has not run. It lives on its manifest ref and owns no branch and no worktree until something needs one.

This skill never creates or restructures a Work. Creation, refinement, dependencies, supersede, follow-up, and cancellation all happen only by applying an Initiative document — use the `codepatrol-spec` skill for any of them.

The entire lifecycle runs with no Git remote configured. Optional publication is a projection that never governs local state.

1. Interpret the request as list, graph, show, Change inspection, checkout, or Backlog refresh. If it asks to create or restructure a Work, hand off to `codepatrol-spec` instead.
2. With no explicit Work, list open Works. Never select by recency when more than one is eligible; ask for an exact Work ID.
3. Use `work graph` to see the whole dependency graph, each Work's derived status, and the executable frontier. Statuses are `blocked`, `executable`, `active`, `accepted`, `rolled-back`, `superseded`, and `cancelled`.
4. Only an accepted blocker releases its dependents. Plan and Review run while blocked; Build refuses to start until every blocker is accepted, and says which one is holding it up.
5. Use `work show` for lifecycle facts, blockers, and provenance, and `change show` or `change diff` for the delivery candidate. Never inspect `.codepatrol/**` directly, and do not call GitHub directly — read Issue and Project state through `sync` output.
6. Use `change refresh` only on a ready, non-terminal Work with no active run. It preserves history, rejects conflicts before mutation, and invalidates a standing Verify.
7. Use `work checkout` only when an isolated checkout is genuinely needed. A Work remains valid without one.
8. For follow-up suggestions, cite concrete results, returns, evidence, or terminal outcomes. Turning a suggestion into Work means writing an Initiative document, not calling this skill.
9. After selecting a Work, report the exact resume command for its current state. For a Work that has not started, identify Plan as next but do not start it.

Command forms:

```bash
codepatrol --workspace /absolute/path/to/repository work list
codepatrol --workspace /absolute/path/to/repository work graph
codepatrol --workspace /absolute/path/to/repository work show <work-id>
codepatrol --workspace /absolute/path/to/repository change show <work-id>
codepatrol --workspace /absolute/path/to/repository change diff <work-id>
codepatrol --workspace /absolute/path/to/repository change refresh <work-id>
codepatrol --workspace /absolute/path/to/repository work checkout <work-id>
```

Local Work `issueType` is authoritative. Optional `sync` projects it to a namespaced GitHub label and projects local status; remote state never chooses a transition. Retry failed publication with:

```bash
codepatrol --workspace /absolute/path/to/repository sync --work <work-id>
```

A publication failure never means the Work should be proposed again; local state already holds the fact.
