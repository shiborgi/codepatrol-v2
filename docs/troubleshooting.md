# Troubleshooting

For failures with a recovery path, see [recovery](recovery.md). This page covers the ones that are about setup rather than state.

## `Could not determine the base branch; pass an explicit base`

The repository has no remote default branch, no checked-out branch, and no `init.defaultBranch`. Check out the branch accepted Works should integrate into.

## `The local <branch> branch is required`

Publication compares local and remote refs and needs the base branch to exist locally. Fetch and check it out.

## `Base must be a refs/heads/* ref`

Codepatrol integrates into a branch, not a tag or a detached commit. Pass a full `refs/heads/...` ref.

## `Workspace must be the Git repository root`

`--workspace` is the main repository root, not a subdirectory and not a Change worktree — including while a stage is running inside one. The worktree path is reported by `start`; use it for editing, and keep `--workspace` pointed at the root.

## `JSON input must be outside the repository and its worktrees`

Todo, trace, result, and Initiative documents are command input, not product content. A file inside the repository would be committed or reported as a pending change. Write them to an absolute path outside every worktree and delete them afterwards.

## `The gh CLI is required for GitHub publication`

Only publication needs `gh`. Every lifecycle command works without it. If you do not want publication, ensure no GitHub remote is configured and it reports `skipped`.

## `gh ... failed: ...` during sync

Local state already landed and is authoritative. Fix the `gh` authentication or permissions and retry `sync`; do not repeat the lifecycle command.

## `git merge-tree` errors, or squash and refresh behaving oddly

Git 2.38 or later is required for `merge-tree --write-tree`. Older Git lacks it, which is what lets Codepatrol compute a squash without touching any checkout.

```bash
git --version
```

## A stage refuses to start because the Work "expects" another stage

The lifecycle graph is enforced: `plan → review → build → verify → ship`, with returns only along `review → plan`, `build → plan`, and `verify → build | plan`. `work show <work-id>` reports the stage the Work is actually at, and `nextCommand` is the exact command for it.

## `work create` is rejected

It no longer exists. Works come only from applying an Initiative document — use the `codepatrol-spec` skill, then `codepatrol spec apply`.

## The tool made the base branch look dirty

It should not: Codepatrol registers `/.codepatrol/runtime/` in `.git/info/exclude` on first use, keeping its own worktrees out of your `.gitignore` and out of `git status`. If you see runtime files in `git status`, that entry was removed; the next Codepatrol command restores it.

## Verify passes locally but Codepatrol says a command is missing

`verify.requiredCommands` matches the exact argument array. `npm run verify` does not satisfy a policy requiring `["npm","run","verify","--","--ci"]`. Record what you actually ran with `verify trace`, and check the policy at `.codepatrol/policy.json`.
