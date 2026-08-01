# Security Policy

## Supported Versions

Security fixes are provided for the latest release on `main`.

## Reporting A Vulnerability

Do not open a public issue for a suspected vulnerability or include credentials, tokens, personal data, or private repository content in a report.

Use GitHub private vulnerability reporting for this repository. Include affected versions, reproduction steps, impact, and any suggested mitigation. If private vulnerability reporting is unavailable, contact the maintainer through the private contact method listed on the maintainer's GitHub profile.

## Execution Data

Treat versioned Work fields, product artifacts, result summaries, handoffs, traces, and published Issue or Project content as potentially public. Trace only the evidence needed for a decision. Never include credentials, tokens, raw environment dumps, private prompts, unrelated command output, or sensitive file contents.

Todo, trace, and result JSON are temporary command inputs. Create them at absolute paths outside the repository and all linked worktrees, restrict their filesystem permissions as appropriate, and remove them when the run is complete. Do not declare them as product artifacts.

## Command output and secrets

Codepatrol runs the commands `.codepatrol/policy.json` requires and records the result as evidence. That evidence reaches the Work manifest, the manifest reaches the base branch through the accept squash, and the base branch is pushed — so anything a Verify command prints is permanent and, on a public repository, published.

**By default the manifest records no command output at all** — only the exit code, a SHA-256 of the complete output, its byte count, and how many credential shapes were detected. The full output is written to `.codepatrol/runtime/`, which is excluded from Git and cleared on the next run.

That is the only default that cannot leak. Redaction is a pattern net: it catches GitHub tokens, AWS keys, JWTs, `Authorization` headers, PEM private keys, URL credentials, and `key=value` pairs naming a password, secret, token, or API key — and it cannot catch a secret in a shape nobody anticipated. Keeping nothing removes the question.

A repository that wants a diagnostic excerpt in the ledger opts in:

```json
{ "verify": { "requiredCommands": [["npm", "run", "verify"]], "persistOutputExcerpt": true } }
```

The excerpt is then a bounded, redacted tail of roughly 2 KB per stream. Turn it on only where the repository is private and the trade is understood.

Either way: do not print credentials from a Verify command, and do not embed one in `requiredCommands`. That file is committed, so a secret there was exposed before Codepatrol ever ran.

Terminal evidence stays in the manifest: attempts, traces, results, and artifacts, with command output reduced to a digest by default. Raw output, trace data, and internal paths are never published to an Issue, a Milestone, or a Project.

`.codepatrol/**` is orchestration state controlled by the CLI. Executors must not read, write, stage, commit, or delete it. Product artifacts belong at ordinary repository paths and command evidence belongs in trace/result inputs.

GitHub publication is optional and local state remains authoritative. Grant `gh` only the repository and Project access required by the target owner. The local Work's `Bug`, `Feature`, or `Task` Issue Type and lifecycle status may be published, along with managed attempt evidence and terminal summaries.
