# Compatibility policy

## What is stable in 1.x

These are the contracts Codepatrol will not break without a major version:

- **CLI surface** — command names, their actions, and their flags.
- **JSON output shape** — every successful command answers with JSON; fields are added, not removed or repurposed.
- **Error codes** — the `error` field of a failure. Messages and `recovery` details may improve.
- **Work manifest**, `schemaVersion: 1` — the versioned record at `.codepatrol/works/<work-id>/work.json`.
- **Handoff**, `schemaVersion: 1` — the derived execution view returned by `start` and `resume`.
- **Initiative document**, `schemaVersion: 1` — the declarative document Spec applies against the graph.
- **Initiative**, `schemaVersion: 1` — the versioned record at `refs/codepatrol/initiative/<id>`.
- **Ref layout** — `refs/codepatrol/manifest/*` (each Work's home, always present), `refs/heads/codepatrol/work/*` (a Work's code, only while it has some), `refs/heads/codepatrol/archive/*` (the frozen terminal code record), `refs/codepatrol/initiative/*`, `refs/heads/codepatrol/recovery/*`.
- **Integration trailers** — `Codepatrol-Work:` and `Codepatrol-Issue:` on the squash commit.

## Schema versioning

The manifest, the handoff, and the Initiative document are versioned independently, because they change for different reasons: the manifest is durable state, the handoff is a derived view, and the document is transient input.

Every parser rejects an unknown `schemaVersion` explicitly rather than guessing, and unknown fields are always refused: a misspelled key must fail, not be silently dropped.

**There is no migration path, by design.** Within 1.x, schemas only gain fields, and a Codepatrol that understands `schemaVersion: 1` keeps understanding it. Changing a `schemaVersion` is a breaking change and therefore a major version — at which point migration becomes a real question with real manifests behind it. Until then, writing a migration would mean carrying a compatibility path that no repository needs.

## What is not a contract

- Prose in summaries, handoffs, and comment bodies.
- The internal layout of `.codepatrol/runtime/**`, which is regenerable and never authoritative.
- The exact commit messages of Codepatrol's own manifest checkpoints.
- Skill wording. The commands the skills invoke are stable; how they explain them is not.

## GitHub

GitHub state is never authoritative and is never migrated. If a projection format changes, the next `sync` rewrites the managed sections it owns and leaves everything else untouched.
