# Changelog

This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 1.0.0

First release.

Codepatrol is a local-first, Git-native orchestrator for agent-driven change. A **Work** records one demand and its lifecycle on its own manifest ref; its **Change** is the delivery candidate carried by a branch that exists only while there is code. Git and the Work manifest are authoritative, and GitHub is a projection that never decides anything.

### Spec is the only entry

Works are never created or restructured by hand. The `codepatrol-spec` skill reads an intent or the repository and writes an Initiative document; the Core validates it and applies it.

- Documents are dry-run by default and carry the digest of the graph they were written against. One written against a graph that has since moved is refused rather than applied to a state its author never saw.
- Applying is one Git ref transaction: several Works, their manifest refs, and their dependency edges land together or none of them do.
- Creating, updating, and rewiring are what the diff computes; only `cancel`, `supersede`, and `followUp` are explicit, and each requires an authority.

### Lifecycle

`plan → review → build → verify → ship`, with returns only along `review → plan`, `build → plan`, and `verify → build | plan`. Accept adds exactly one squash commit to the base; rollback adds none. Both preserve the Change's code in an archive ref when the Work had code; a Work that never had content terminalizes on its manifest ref alone.

A decision that carries the work forward cannot rest on a failed todo item, and a skipped item owes a justification.

### Work graph

Works may depend on each other. Plan and Review run while blocked; Build refuses to start until every blocker is **accepted** — rolled back, superseded, and cancelled never release a dependent. Direct and transitive cycles are refused, including ones that would exist only once a document's new Works land. `spec inspect` reports the attack order derived from the graph: waves of what could run together, and the critical path.

### Verification

`.codepatrol/policy.json` declares `requiredCommands` as exact argument arrays. Codepatrol runs them itself and binds each result to the Work, run, attempt, candidate commit, and policy hash, so a claim of success cannot be inherited or fabricated. A repository without a policy cannot start Verify.

### Terminal evidence

A Work leaves behind exactly what it recorded while it ran — attempts, traces, results, artifacts — and its outcome in `completion`. Ship contributes a decision and an authority, nothing more. Spec reads that terminal evidence directly to write the next Initiative; turning evidence into a Work means a normal document, normal validation, and a human's approval.

```text
Work execution → terminal evidence → Spec → Initiative document → approval → new Works
```

### Projections

Issues, Project items, and Milestones project local state; each Initiative projects onto exactly one Milestone. Integration is a local squash; nothing is merged through GitHub. Every command works without a remote; publication then reports `skipped`.

Each projection is gated by `.codepatrol/config.json`: a disabled projection is never written, and a repository with no configuration projects nothing. A resolvable remote is not permission to use it.

### Secrets

The manifest records a digest, byte count, and redaction count of each Verify command's output — and, by default, none of the output itself. The manifest reaches the base branch and is pushed, and redaction is a pattern net rather than a guarantee, so keeping nothing is the only default that cannot leak. `verify.persistOutputExcerpt` opts in to a bounded, redacted tail.

### Requirements

Node.js 20 or later and Git 2.38 or later, on Linux or macOS. See [`docs/installation.md`](docs/installation.md), [`docs/compatibility.md`](docs/compatibility.md), and [`docs/limitations.md`](docs/limitations.md).
