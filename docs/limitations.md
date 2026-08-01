# Known limitations

Stated plainly, because discovering them mid-lifecycle is worse than reading them here.

## Not in 1.0.0

These are deliberate exclusions, not oversights:

- **Spec is not a persistent entity and not a lifecycle stage.** Initiative documents are transient. Provenance survives on each Work as a digest; the raw prompt never becomes canonical state.
- **No autonomous scheduling.** Codepatrol never starts a stage on its own. Every transition is invoked.
- **No parallel agent execution.** One active run per Work, enforced by the manifest.
- **Plan produces prose, not an executable DAG.** A Plan result is read by the next stage, not run.
- **No repository-wide architecture audit.** Spec inspects what it is pointed at.
- **No advanced context compression.** Handoffs carry the full attempt history.

## Self-improvement never acts on its own

By design, and enforced by the code: nothing rewrites code, skills, or the Verify policy from terminal evidence. Every follow-up Work goes through an Initiative document, its validation, and a human's approval.

## Verify command output is not kept by default

The manifest records a digest, a byte count, and a redaction count — no output. The untouched output lives in `.codepatrol/runtime/`, which is disposable and outside Git.

`verify.persistOutputExcerpt` opts in to a bounded, redacted tail in the ledger. It is off by default because redaction is a pattern net, not a guarantee, and the manifest reaches the base branch permanently. A secret embedded in `.codepatrol/policy.json` itself was already committed before Codepatrol ran. See [secret handling](../SECURITY.md).

## Verified platforms

CI covers Linux and macOS on Node.js 20 and 22.

**Windows is not verified.** The code paths that would need it exist — hooks are suppressed with `core.hooksPath=NUL`, paths are normalized — but no test has run there, so Windows is unsupported until CI covers it. Use WSL.

## The verification policy is not editable by a Work

`.codepatrol/**` is reserved: a Change may write its own manifest and nothing else under it. That is what stops a candidate relaxing the rules it is judged by — and it also means a Work cannot legitimately update `.codepatrol/policy.json`. Changing the policy is a commit by the repository owner, outside the Codepatrol flow.

## `policyHash` is a record, not a race guard

The snapshot stores which policy a verification was made under so an archived manifest still says so months later. It does not independently catch a policy change mid-Verify: the candidate cannot alter the policy, and a base that moved is already caught by `targetCommit`.

## Project board vocabulary

GitHub Project Status and Outcome are separate fields. Status tracks workflow position: `Backlog`, `Plan`, `Review`, `Build`, `Verify`, `Ship`, `Done`. Outcome tracks terminal result: `None`, `Accepted`, `Rolled back`, `Superseded`, `Cancelled`. Terminal Works project as `Status=Done` with the appropriate Outcome. GitHub Project state is non-authoritative: it is written by sync, never read to drive lifecycle transitions.

## Dependency state is local only

Blocker resolution is read from local manifests. A blocker that exists only on the remote is treated as unresolved. Run `sync` first if your backlog is shared.

## Concurrency

Codepatrol serializes its own operations with Git ref locks, which are per repository and per machine. Two people driving the same working copy simultaneously is not a supported mode; two clones are, because Git is the source of truth.
