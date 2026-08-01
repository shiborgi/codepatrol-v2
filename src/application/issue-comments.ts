import { CodepatrolError } from "../core/errors.js";
import { sha256 } from "../core/json.js";
import { changeOf } from "../core/change.js";
import { type ExecutionIdentity, type ShipOutcome, type Stage, type TodoItem } from "../core/types.js";
import { archiveRef, type ManifestResult, type ManifestTrace, type WorkManifest } from "../core/work-manifest.js";
import type { GitHubComment, GitHubIssues } from "./ports.js";

const MARKER = /^<!-- codepatrol-publication:v1 (attempt|ship-summary|spec-outcome) ([^\s]+) ([^\s]+) -->$/;
const MAX_COMMENT_BYTES = 60_000;
const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

export interface AttemptCommentFacts {
  workId: string;
  stage: Stage;
  attempt: number;
  runId: string;
  status: string;
  execution: ExecutionIdentity;
  startedAt: string;
  finishedAt?: string;
  todo: TodoItem[];
  result?: ManifestResult;
  traces: ManifestTrace[];
}

export interface ShipCommentFacts {
  workId: string;
  runId: string;
  outcome: ShipOutcome;
  authority: string;
  shippedAt: string;
  elapsedMs: number;
  finalSummary: string;
  state: string;
  archiveRef: string;
  returns: number;
  invalidatedAttempts: number;
}

export interface SpecOutcomeCommentFacts {
  workId: string;
  outcome: "superseded" | "cancelled";
  authority: string;
  finalizedAt: string;
  summary: string;
  replacedBy: string[];
  archiveRef: string;
}

export interface DesiredIssueComment {
  key: string;
  body: string;
}

export interface CommentSyncSummary {
  created: Array<{ issue: number; key: string; comment: number }>;
  updated: Array<{ issue: number; key: string; comment: number }>;
  deleted: Array<{ issue: number; key: string; comment: number }>;
  unchanged: Array<{ issue: number; key: string; comment: number }>;
}

function safe(value: string): string {
  return value
    .replace(/[\0-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
    .replaceAll("\\", "\\\\")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("`", "&#96;")
    .replaceAll("@", "&#64;")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]")
    .replaceAll("|", "\\|")
    .replace(/[*_~#+!-]/g, (character) => `\\${character}`)
    .replace(/[\r\n]+/g, " ")
    .trim();
}

function marker(kind: "attempt" | "ship-summary" | "spec-outcome", workId: string, runId: string): string {
  return `<!-- codepatrol-publication:v1 ${kind} ${workId} ${runId} -->`;
}

function limited(body: string): string {
  if (Buffer.byteLength(body) <= MAX_COMMENT_BYTES) return body;
  const suffix = `\n\n_Content truncated deterministically. SHA-256: \`${sha256(body)}\`_\n`;
  const codePoints = Array.from(body);
  let low = 0;
  let high = codePoints.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(codePoints.slice(0, middle).join("")) + Buffer.byteLength(suffix) <= MAX_COMMENT_BYTES) low = middle;
    else high = middle - 1;
  }
  return `${codePoints.slice(0, low).join("")}${suffix}`;
}

function statusLabel(status: string): string {
  return ({ active: "In progress", completed: "Completed", returned: "Returned", invalidated: "Invalidated", abandoned: "Abandoned" } as Record<string, string>)[status] ?? status;
}

export function renderAttemptComment(facts: AttemptCommentFacts): DesiredIssueComment {
  const resultByTodo = new Map(facts.result?.todo.map((item) => [item.id, item]));
  const lines = [
    marker("attempt", facts.workId, facts.runId),
    "",
    `### Codepatrol · \`${facts.stage}\` · attempt ${facts.attempt}`,
    "",
    "| Field | Value |",
    "|---|---|",
    `| Status | ${safe(statusLabel(facts.status))} |`,
    `| Role | \`${safe(facts.execution.role)}\` |`,
    `| Harness | \`${safe(facts.execution.harness)}\` |`,
    `| Model | \`${safe(facts.execution.model)}\` |`,
    `| Run | \`${facts.runId}\` |`,
    `| Started | \`${facts.startedAt}\` |`,
    ...(facts.finishedAt === undefined ? [] : [`| Finished | \`${facts.finishedAt}\` |`, `| Duration | ${Math.max(0, Date.parse(facts.finishedAt) - Date.parse(facts.startedAt))} ms |`]),
    "",
    "#### Todo",
    "",
    ...facts.todo.map((item) => {
      const outcome = resultByTodo.get(item.id);
      const checked = outcome?.status === "completed" ? "x" : " ";
      const suffix = outcome === undefined ? "" : ` · \`${outcome.status}\`${outcome.note === undefined ? "" : ` · ${safe(outcome.note)}`}`;
      return `- [${checked}] \`${safe(item.id)}\` ${safe(item.title)}${suffix}`;
    }),
  ];

  if (facts.result !== undefined) {
    lines.push(
      "",
      "#### Result",
      "",
      `**Decision:** \`${facts.result.decision}\``,
      "",
      safe(facts.result.summary),
      "",
      `**Handoff:** ${safe(facts.result.handoff)}`,
    );
    if (facts.result.returnTo !== undefined) lines.push("", `**Return:** \`${facts.result.returnTo}\``);
    if (facts.result.reasons !== undefined) lines.push("", ...facts.result.reasons.map((reason) => `- ${safe(reason)}`));
  }

  if (facts.traces.length > 0) {
    lines.push("", "<details>", `<summary>Tracing (${facts.traces.length})</summary>`, "");
    for (const trace of facts.traces) lines.push(`- \`${trace.type}\`: ${safe(trace.message)}`);
    lines.push("", "</details>");
  }

  const body = limited(`${lines.join("\n")}\n`);
  return { key: `attempt:${facts.workId}:${facts.runId}`, body };
}

export function renderShipComment(facts: ShipCommentFacts): DesiredIssueComment {
  const body = limited(`${[
    marker("ship-summary", facts.workId, facts.runId),
    "",
    "### Codepatrol · Ship",
    "",
    `**Outcome:** \`${facts.outcome}\`  `,
    `**Authority:** \`${safe(facts.authority)}\`  `,
    `**Shipped:** \`${facts.shippedAt}\`  `,
    `**Cycle duration:** ${facts.elapsedMs} ms  `,
    `**Change:** \`${facts.state}\`  `,
    `**Archive:** \`${safe(facts.archiveRef)}\`  `,
    `**Returns:** ${facts.returns}  `,
    `**Invalidated attempts:** ${facts.invalidatedAttempts}  `,
    "",
    safe(facts.finalSummary),
    "",
    `Versioned record: \`.codepatrol/works/${facts.workId}/work.json\``,
  ].join("\n")}\n`);
  return { key: `ship-summary:${facts.workId}:${facts.runId}`, body };
}

/**
 * A Work ended by a graph decision rather than by Ship.
 *
 * It is rendered separately because it is not a Ship outcome: nothing was
 * accepted or rolled back, and the base was never touched.
 */
export function renderSpecOutcomeComment(facts: SpecOutcomeCommentFacts): DesiredIssueComment {
  const body = limited(`${[
    marker("spec-outcome", facts.workId, facts.outcome),
    "",
    "### Codepatrol · Spec",
    "",
    `**Outcome:** \`${facts.outcome}\`  `,
    `**Authority:** \`${safe(facts.authority)}\`  `,
    `**Decided:** \`${facts.finalizedAt}\`  `,
    ...(facts.replacedBy.length === 0 ? [] : [`**Replaced by:** ${facts.replacedBy.map((id) => `\`${safe(id)}\``).join(", ")}  `]),
    `**Archive:** \`${safe(facts.archiveRef)}\`  `,
    "",
    safe(facts.summary),
    "",
    "This Work was ended by a Spec decision. It was neither accepted nor rolled back, and the base branch was never changed.",
  ].join("\n")}\n`);
  return { key: `spec-outcome:${facts.workId}`, body };
}

/**
 * The single adaptation from canonical attempt data to rendered comments.
 */
export function manifestComments(manifest: WorkManifest): DesiredIssueComment[] {
  const comments = manifest.attempts.map((attempt) => renderAttemptComment({
    workId: manifest.work.id,
    stage: attempt.stage,
    attempt: attempt.attempt,
    runId: attempt.runId,
    status: attempt.status,
    execution: attempt.execution,
    startedAt: attempt.startedAt,
    ...(attempt.finishedAt === undefined ? {} : { finishedAt: attempt.finishedAt }),
    todo: attempt.todo,
    ...(attempt.result === undefined ? {} : { result: attempt.result }),
    traces: attempt.traces ?? [],
  }));
  const completion = manifest.completion;
  const shipRun = [...manifest.attempts].reverse().find((attempt) => attempt.stage === "ship");
  if (completion !== null && completion.via === "ship" && shipRun !== undefined) {
    comments.push(renderShipComment({
      workId: manifest.work.id,
      runId: shipRun.runId,
      outcome: completion.outcome as ShipOutcome,
      authority: completion.authority,
      shippedAt: completion.finalizedAt,
      elapsedMs: Date.parse(completion.finalizedAt) - Date.parse(manifest.work.createdAt),
      finalSummary: completion.summary,
      state: changeOf(manifest).state,
      archiveRef: archiveRef(manifest.work.id),
      returns: manifest.attempts.filter((attempt) => attempt.status === "returned").length,
      invalidatedAttempts: manifest.attempts.filter((attempt) => attempt.status === "invalidated").length,
    }));
  }
  if (completion !== null && completion.via === "spec") {
    comments.push(renderSpecOutcomeComment({
      workId: manifest.work.id,
      outcome: completion.outcome as "superseded" | "cancelled",
      authority: completion.authority,
      finalizedAt: completion.finalizedAt,
      summary: completion.summary,
      replacedBy: completion.replacedBy ?? [],
      archiveRef: archiveRef(manifest.work.id),
    }));
  }
  return comments;
}

function commentKey(body: string): string | undefined {
  const match = MARKER.exec(body.split(/\r?\n/, 1)[0] ?? "");
  return match === null ? undefined : `${match[1]}:${match[2]}:${match[3]}`;
}

export async function reconcileIssueComments(github: GitHubIssues, repository: string, issueNumber: number, owner: string, desired: DesiredIssueComment[]): Promise<CommentSyncSummary> {
  const summary: CommentSyncSummary = { created: [], updated: [], deleted: [], unchanged: [] };
  const existing = await github.listComments(repository, issueNumber);
  const byKey = new Map<string, GitHubComment[]>();
  for (const comment of existing) {
    const trusted = comment.author.toLowerCase() === owner.toLowerCase() || (comment.authorAssociation !== undefined && TRUSTED_ASSOCIATIONS.has(comment.authorAssociation.toUpperCase()));
    if (!trusted) continue;
    const key = commentKey(comment.body);
    if (key === undefined) continue;
    const comments = byKey.get(key) ?? [];
    comments.push(comment);
    byKey.set(key, comments);
  }
  const desiredKeys = new Set<string>();
  for (const item of desired) {
    if (desiredKeys.has(item.key)) throw new CodepatrolError("STATE_CORRUPT", `Duplicate desired comment key: ${item.key}.`);
    desiredKeys.add(item.key);
    const matches = [...(byKey.get(item.key) ?? [])].sort((left, right) => left.id - right.id);
    const retained = matches[0];
    if (retained === undefined) {
      const created = await github.createComment(repository, issueNumber, item.body);
      summary.created.push({ issue: issueNumber, key: item.key, comment: created.id });
      continue;
    }
    if (retained.author.toLowerCase() !== owner.toLowerCase()) {
      if (retained.body !== item.body) throw new CodepatrolError("SYNC_CONFLICT", `Managed comment ${retained.id} belongs to ${retained.author}; use the same GitHub publisher to update it.`);
      summary.unchanged.push({ issue: issueNumber, key: item.key, comment: retained.id });
      for (const duplicate of matches.slice(1)) {
        if (duplicate.body !== item.body) throw new CodepatrolError("SYNC_CONFLICT", `Comment ${duplicate.id} diverges from managed key ${item.key}.`);
        if (duplicate.author.toLowerCase() === owner.toLowerCase()) {
          await github.deleteComment(repository, duplicate.id);
          summary.deleted.push({ issue: issueNumber, key: item.key, comment: duplicate.id });
        }
      }
      continue;
    }
    if (retained.body === item.body) summary.unchanged.push({ issue: issueNumber, key: item.key, comment: retained.id });
    else {
      await github.editComment(repository, retained, item.body);
      summary.updated.push({ issue: issueNumber, key: item.key, comment: retained.id });
    }
    for (const duplicate of matches.slice(1)) {
      if (duplicate.author.toLowerCase() !== owner.toLowerCase()) {
        if (duplicate.body !== item.body) throw new CodepatrolError("SYNC_CONFLICT", `Foreign comment ${duplicate.id} duplicates managed key ${item.key}.`);
        continue;
      }
      await github.deleteComment(repository, duplicate.id);
      summary.deleted.push({ issue: issueNumber, key: item.key, comment: duplicate.id });
    }
  }
  return summary;
}
