# Installation

## Requirements

| Requirement | Version | Why |
|---|---|---|
| Node.js | 20 or later | The CLI is ESM and uses `node:test` for its own suite. Verified on 20 and 22. |
| Git | 2.38 or later | `git merge-tree --write-tree` performs conflict-free squash and refresh computation without touching any checkout. |
| Operating system | Linux, macOS | Verified in CI. See [limitations](limitations.md) regarding Windows. |
| `gh` CLI | 2.x, authenticated | Only for optional GitHub publication. Every lifecycle command works without it. |

Check your Git version before installing: `git merge-tree --write-tree` is load-bearing, and older Git silently lacks it.

```bash
git --version
node --version
```

## Install

```bash
npm install --global codepatrol
codepatrol --version
```

Or per project:

```bash
npm install --save-dev codepatrol
npx codepatrol --help
```

## Initialization

Codepatrol works in any Git repository with at least one commit. Initialize it explicitly:

```bash
cd /path/to/your/repository
codepatrol init --verify-commands '[["npm","test"]]'
```

`init` creates `.codepatrol/config.json` and `.codepatrol/policy.json`, installs harness adapters when requested, and protects the runtime directory. It is idempotent: running it again with the same inputs changes nothing. Pass `--replace` to overwrite existing configuration after reviewing it.

Options:

- `--base <branch>` — explicit base branch (default: resolved from remote, HEAD, or `init.defaultBranch`).
- `--verify-commands '<json>'` — JSON array of command argument arrays, e.g. `'[["npm","run","verify"]]'`. Inferred from `package.json` `scripts.verify` when omitted.
- `--harness opencode|claude|none` — install thin harness adapters (default: `none`).
- `--github` — enable GitHub projections (Issue, refs). Project is disabled by default.
- `--project disabled|managed|existing` — Project board mode.
- `--project-number <n>` — required with `--project existing`.
- `--replace` — overwrite existing configuration files.

After initialization, commit the generated files:

```bash
git add .codepatrol/config.json .codepatrol/policy.json
git commit -m "codepatrol init"
```

## Diagnostics

```bash
codepatrol doctor
```

`doctor` validates Node.js, Git, repository state, base branch, configuration, Verify policy, writable Git directory, ref namespace availability, harness adapters, and optional GitHub projections. Output is machine-readable JSON: `{ "status": "ready" | "failed", "checks": [...] }`. Every failed check includes a safe next action. The command exits non-zero when the repository is not ready.

## First run

```bash
codepatrol --workspace "$PWD" spec inspect
```

An empty backlog answers with an empty graph and a digest. Nothing has been written: `spec inspect` is read-only.

`--workspace` is always the main repository root, given as an absolute path — including when a stage is running inside a Change worktree.

## Harness adapters

The skills under `skills/codepatrol-*/SKILL.md` are harness-neutral. `codepatrol init --harness opencode` or `--harness claude` installs thin adapters automatically.

To install manually:

- **OpenCode** — `opencode.json` with `{ "skills": { "paths": ["./skills"] } }`.
- **Claude Code** — symlink each skill into `.claude/skills/`, and add a thin command per skill under `.claude/commands/` that supplies only the truthful harness and model identity.

An adapter must not duplicate lifecycle policy or invoke the next stage. The skills own that.

## Optional GitHub publication

```bash
gh auth status
codepatrol --workspace "$PWD" sync
```

Publication needs `gh` with access to the repository and, if you use one, the Project. Without a suitable remote, publication reports `skipped` and local work continues unchanged.

GitHub projections are configured in `.codepatrol/config.json`. Each projection (refs, Issue, Project) can be enabled or disabled independently. Project supports `disabled`, `managed`, and `existing` modes.

A disabled projection is never written, and a repository without `.codepatrol/config.json` projects nothing at all: publication reports `skipped` even when a GitHub remote exists. Enable projections with `codepatrol init --github` (add `--project managed` for the board).
