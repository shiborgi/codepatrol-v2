import { CodepatrolError } from "./errors.js";
import { BRANCH_REF, GIT_HASH, TRACE_ID, UUID, WORK_ID } from "./identifiers.js";
import { INITIATIVE_ID } from "./initiative.js";
import { parseAttemptTelemetry, type AttemptTelemetry } from "./telemetry.js";
import { ATTEMPT_STATUSES, ISSUE_TYPES, todoContractViolations, RETURN_TARGETS, SHIP_OUTCOMES, STAGES, STAGE_ROLES, WORK_OUTCOMES, WORK_PRIORITIES, type AttemptStatus, type ExecutionIdentity, type IssueType, type ShipOutcome, type Stage, type TodoItem, type TodoResult, type WorkIdentity, type WorkInitiative, type WorkOrigin, type WorkOutcome, type WorkPriority } from "./types.js";

export const MANIFEST_SCHEMA_VERSION = 1;
export const MANIFEST_TYPE = "codepatrol-work";

export function manifestPath(workId: string): string {
  return `.codepatrol/works/${workId}/work.json`;
}

export function workBranchRef(workId: string): string {
  return `refs/heads/codepatrol/work/${workId}`;
}

export function archiveRef(workId: string): string {
  return `refs/heads/codepatrol/archive/${workId}`;
}

/**
 * The Work's home. The manifest commit lives on this ref: it is created by
 * Spec, is always present, and is the only authority on the Work. Branches are
 * where a Change keeps its code, and come and go without affecting it.
 */
export function manifestRef(workId: string): string {
  return `refs/codepatrol/manifest/${workId}`;
}

/** An artifact committed on the Change branch, addressed by its git blob. */
export interface ManifestArtifact {
  path: string;
  kind: string;
  blob: string;
  description?: string;
}

export interface ManifestTrace {
  /**
   * Stable handle for this trace, so a trace reference can cite it as
   * `trace:<id>` instead of depending on its position in an array.
   */
  id: string;
  type: "observation" | "decision" | "action" | "error" | "metric" | "command";
  message: string;
  at: string;
  data?: Record<string, unknown>;
  command?: string[];
  exitCode?: number;
}

export interface ManifestResult {
  decision: "continue" | "return" | "accept" | "rollback";
  summary: string;
  handoff: string;
  todo: TodoResult[];
  artifacts: ManifestArtifact[];
  returnTo?: Stage;
  reasons?: string[];
  authority?: string;
}

export interface ManifestAttempt {
  stage: Stage;
  attempt: number;
  runId: string;
  status: AttemptStatus;
  execution: ExecutionIdentity;
  startedAt: string;
  todo: TodoItem[];
  finishedAt?: string;
  result?: ManifestResult;
  traces?: ManifestTrace[];
  verificationTarget?: VerificationSnapshot;
  verifiedCandidate?: VerificationSnapshot;
  /**
   * Bounded, privacy-safe telemetry. Best-effort and non-authoritative. Absent
   * when no collector was injected or the collector failed — schemaVersion 1
   * does not require the field.
   */
  telemetry?: AttemptTelemetry;
}

export interface ManifestRepository {
  baseRef: string;
  /**
   * Present exactly while the Work has a branch. Both are recorded when the
   * branch is cut, from the base as it stands then: a backlog Work has no
   * baseline to drift from, because it has no branch yet.
   */
  createdFromCommit?: string;
  baselineCommit?: string;
}

export interface ManifestIssue {
  repository: string;
  number: number;
}

/**
 * Exactly what was verified, and under what rules.
 *
 * Two commits are pinned, because the manifest no longer lives on the Change
 * branch: `candidateCommit` is the code head the commands ran against, and
 * `manifestCommit` is the manifest checkpoint the attempt was bound to. Neither
 * can be inferred from the other.
 *
 * `attempt` stops a snapshot being read as belonging to a later Verify.
 * `policyHash` is a record rather than a race guard: the candidate cannot alter
 * `.codepatrol/policy.json` (it is reserved) and a base that moved is already
 * caught by `targetCommit`, so the hash exists so that an archived manifest
 * still says which rules its verification was made under.
 */
export interface VerificationSnapshot {
  attempt: number;
  candidateCommit: string;
  manifestCommit: string;
  baselineCommit: string;
  targetCommit: string;
  policyHash: string;
}

export interface ManifestWorkflow {
  state: "ready" | "active" | "terminal";
  stage: Stage;
  attempt: number;
  updatedAt: string;
}

/**
 * A Work's outgoing dependency edges.
 *
 * Edges live on the dependent rather than the blocker, so adding or removing a
 * dependency writes exactly one manifest. A blocker never has to be reopened —
 * which matters because a blocker is usually the terminal Work.
 */
export interface ManifestGraph {
  blockedBy: string[];
}

export interface ManifestCompletion {
  outcome: WorkOutcome;
  /** `ship` for a lifecycle decision, `spec` for a graph decision. */
  via: "ship" | "spec";
  authority: string;
  finalizedAt: string;
  summary: string;
  /** The Works that replace this one; supersede only. */
  replacedBy?: string[];
}

export interface WorkManifest {
  schemaVersion: typeof MANIFEST_SCHEMA_VERSION;
  type: typeof MANIFEST_TYPE;
  work: WorkIdentity;
  repository: ManifestRepository;
  graph: ManifestGraph;
  issue: ManifestIssue | null;
  workflow: ManifestWorkflow;
  attempts: ManifestAttempt[];
  completion: ManifestCompletion | null;
}

export function createManifest(input: { identity: WorkIdentity; baseRef: string; blockedBy?: readonly string[] }): WorkManifest {
  if (!WORK_ID.test(input.identity.id)) throw new CodepatrolError("INVALID_INPUT", `Invalid Work id: ${input.identity.id}.`);
  if (!BRANCH_REF.test(input.baseRef)) throw new CodepatrolError("INVALID_INPUT", `Base must be a refs/heads/* ref: ${input.baseRef}.`);
  const parsed: WorkManifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    type: MANIFEST_TYPE,
    work: input.identity,
    repository: {
      baseRef: input.baseRef,
    },
    graph: { blockedBy: normalizeBlockers(input.blockedBy ?? [], input.identity.id) },
    issue: null,
    workflow: { state: "ready", stage: "plan", attempt: 1, updatedAt: input.identity.createdAt },
    attempts: [],
    completion: null,
  };
  return parsed;
}

/** Sorted, de-duplicated, self-free blockers. Sorting keeps diffs meaningful. */
export function normalizeBlockers(blockers: readonly string[], workId: string): string[] {
  const unique = [...new Set(blockers)].sort();
  for (const blocker of unique) {
    if (!WORK_ID.test(blocker)) throw new CodepatrolError("INVALID_INPUT", `Invalid blocker Work id: ${blocker}.`);
    if (blocker === workId) throw new CodepatrolError("INVALID_INPUT", `A Work cannot block itself: ${workId}.`);
  }
  return unique;
}

function renderSnapshot(snapshot: VerificationSnapshot): Record<string, unknown> {
  return {
    attempt: snapshot.attempt,
    candidateCommit: snapshot.candidateCommit,
    manifestCommit: snapshot.manifestCommit,
    baselineCommit: snapshot.baselineCommit,
    targetCommit: snapshot.targetCommit,
    policyHash: snapshot.policyHash,
  };
}

function renderTelemetry(telemetry: AttemptTelemetry): Record<string, unknown> {
  return {
    skills: { count: telemetry.skills.count, bytes: telemetry.skills.bytes },
    context: { sections: telemetry.context.sections, bytes: telemetry.context.bytes },
    tools: telemetry.tools,
    model: telemetry.model,
  };
}

/**
 * Renders the manifest with a fixed field order. Relying on object spread order
 * would make `git log -p` noisy for changes that are not really changes, and
 * would make round-trip equality order-sensitive.
 */
export function serializeManifest(manifest: WorkManifest): string {
  const ordered = {
    schemaVersion: manifest.schemaVersion,
    type: manifest.type,
    work: {
      id: manifest.work.id,
      title: manifest.work.title,
      description: manifest.work.description,
      issueType: manifest.work.issueType,
      priority: manifest.work.priority,
      acceptance: [...manifest.work.acceptance],
      createdAt: manifest.work.createdAt,
      requestedBy: manifest.work.requestedBy,
      initiative: {
        id: manifest.work.initiative.id,
        position: manifest.work.initiative.position,
      },
      origin: {
        createdAt: manifest.work.origin.createdAt,
        ...(manifest.work.origin.followUpOf === undefined ? {} : { followUpOf: manifest.work.origin.followUpOf }),
      },
    },
    repository: {
      baseRef: manifest.repository.baseRef,
      ...(manifest.repository.createdFromCommit === undefined ? {} : { createdFromCommit: manifest.repository.createdFromCommit }),
      ...(manifest.repository.baselineCommit === undefined ? {} : { baselineCommit: manifest.repository.baselineCommit }),
    },
    graph: { blockedBy: [...manifest.graph.blockedBy] },
    issue: manifest.issue === null ? null : { repository: manifest.issue.repository, number: manifest.issue.number },
    workflow: {
      state: manifest.workflow.state,
      stage: manifest.workflow.stage,
      attempt: manifest.workflow.attempt,
      updatedAt: manifest.workflow.updatedAt,
    },
    attempts: manifest.attempts.map((attempt) => ({
      stage: attempt.stage,
      attempt: attempt.attempt,
      runId: attempt.runId,
      status: attempt.status,
      execution: { role: attempt.execution.role, harness: attempt.execution.harness, model: attempt.execution.model },
      startedAt: attempt.startedAt,
      ...(attempt.finishedAt === undefined ? {} : { finishedAt: attempt.finishedAt }),
      todo: attempt.todo.map((item) => ({ id: item.id, title: item.title, ...(item.description === undefined ? {} : { description: item.description }) })),
      ...(attempt.result === undefined ? {} : {
        result: {
          decision: attempt.result.decision,
          summary: attempt.result.summary,
          handoff: attempt.result.handoff,
          todo: attempt.result.todo.map((item) => ({ id: item.id, status: item.status, ...(item.note === undefined ? {} : { note: item.note }) })),
          artifacts: attempt.result.artifacts.map((item) => ({ path: item.path, kind: item.kind, blob: item.blob, ...(item.description === undefined ? {} : { description: item.description }) })),
          ...(attempt.result.returnTo === undefined ? {} : { returnTo: attempt.result.returnTo }),
          ...(attempt.result.reasons === undefined ? {} : { reasons: attempt.result.reasons }),
          ...(attempt.result.authority === undefined ? {} : { authority: attempt.result.authority }),
        },
      }),
      ...(attempt.traces === undefined || attempt.traces.length === 0 ? {} : {
        traces: attempt.traces.map((trace) => ({
          id: trace.id,
          type: trace.type,
          message: trace.message,
          at: trace.at,
          ...(trace.data === undefined ? {} : { data: trace.data }),
          ...(trace.command === undefined ? {} : { command: trace.command }),
          ...(trace.exitCode === undefined ? {} : { exitCode: trace.exitCode }),
        })),
      }),
      ...(attempt.verificationTarget === undefined ? {} : { verificationTarget: renderSnapshot(attempt.verificationTarget) }),
      ...(attempt.verifiedCandidate === undefined ? {} : { verifiedCandidate: renderSnapshot(attempt.verifiedCandidate) }),
      ...(attempt.telemetry === undefined ? {} : { telemetry: renderTelemetry(attempt.telemetry) }),
    })),
    completion: manifest.completion === null ? null : {
      outcome: manifest.completion.outcome,
      via: manifest.completion.via,
      authority: manifest.completion.authority,
      finalizedAt: manifest.completion.finalizedAt,
      summary: manifest.completion.summary,
      ...(manifest.completion.replacedBy === undefined ? {} : { replacedBy: [...manifest.completion.replacedBy] }),
    },
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

function corrupt(message: string): never {
  throw new CodepatrolError("STATE_CORRUPT", message);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) corrupt(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, allowed: readonly string[], required: readonly string[], label: string): void {
  const actual = Object.keys(value);
  if (actual.some((key) => !allowed.includes(key)) || required.some((key) => !actual.includes(key))) corrupt(`${label} has invalid fields.`);
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") corrupt(`${label} must be a non-empty string.`);
  return value;
}

function iso(value: unknown, label: string): string {
  const result = text(value, label);
  if (!Number.isFinite(Date.parse(result))) corrupt(`${label} must be an ISO timestamp.`);
  return result;
}

function count(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) corrupt(`${label} must be a positive integer.`);
  return value;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) corrupt(`${label} must be an array.`);
  return value;
}

function stageOf(value: unknown, label: string): Stage {
  if (typeof value !== "string" || !STAGES.includes(value as Stage)) corrupt(`${label} is invalid.`);
  return value as Stage;
}

function parseTodoItems(value: unknown, label: string): TodoItem[] {
  const items = array(value, label);
  if (items.length === 0) corrupt(`${label} must not be empty.`);
  const ids = new Set<string>();
  return items.map((raw, index) => {
    const item = object(raw, `${label}[${index}]`);
    keys(item, ["id", "title", "description"], ["id", "title"], `${label}[${index}]`);
    const id = text(item.id, `${label}[${index}].id`);
    if (ids.has(id)) corrupt(`${label} contains duplicate ids.`);
    ids.add(id);
    return { id, title: text(item.title, `${label}[${index}].title`), ...(item.description === undefined ? {} : { description: text(item.description, `${label}[${index}].description`) }) };
  });
}

function parseResultTodo(value: unknown, label: string): TodoResult[] {
  const ids = new Set<string>();
  return array(value, label).map((raw, index) => {
    const item = object(raw, `${label}[${index}]`);
    keys(item, ["id", "status", "note"], ["id", "status"], `${label}[${index}]`);
    if (!["completed", "skipped", "failed"].includes(item.status as string)) corrupt(`${label}[${index}].status is invalid.`);
    const id = text(item.id, `${label}[${index}].id`);
    if (ids.has(id)) corrupt(`${label} contains duplicate ids.`);
    ids.add(id);
    return { id, status: item.status as TodoResult["status"], ...(item.note === undefined ? {} : { note: text(item.note, `${label}[${index}].note`) }) };
  });
}

function parseArtifacts(value: unknown, label: string): ManifestArtifact[] {
  const paths = new Set<string>();
  return array(value, label).map((raw, index) => {
    const item = object(raw, `${label}[${index}]`);
    keys(item, ["path", "kind", "blob", "description"], ["path", "kind", "blob"], `${label}[${index}]`);
    const artifactPath = text(item.path, `${label}[${index}].path`);
    if (artifactPath === "." || artifactPath.startsWith("./") || artifactPath.startsWith("/") || artifactPath.split("/").includes("..")) corrupt(`${label}[${index}].path is unsafe.`);
    if (artifactPath === ".codepatrol" || artifactPath.startsWith(".codepatrol/")) corrupt(`${label}[${index}].path is reserved.`);
    if (paths.has(artifactPath)) corrupt(`${label} contains duplicate paths.`);
    paths.add(artifactPath);
    if (typeof item.blob !== "string" || !GIT_HASH.test(item.blob)) corrupt(`${label}[${index}].blob is invalid.`);
    return { path: artifactPath, kind: text(item.kind, `${label}[${index}].kind`), blob: item.blob, ...(item.description === undefined ? {} : { description: text(item.description, `${label}[${index}].description`) }) };
  });
}

function parseTraces(value: unknown, label: string): ManifestTrace[] {
  const ids = new Set<string>();
  return array(value, label).map((raw, index) => {
    const item = object(raw, `${label}[${index}]`);
    keys(item, ["id", "type", "message", "at", "data", "command", "exitCode"], ["id", "type", "message", "at"], `${label}[${index}]`);
    const id = text(item.id, `${label}[${index}].id`);
    if (!TRACE_ID.test(id)) corrupt(`${label}[${index}].id is invalid.`);
    if (ids.has(id)) corrupt(`${label} contains duplicate trace ids.`);
    ids.add(id);
    if (!["observation", "decision", "action", "error", "metric", "command"].includes(item.type as string)) corrupt(`${label}[${index}].type is invalid.`);
    if (item.data !== undefined) object(item.data, `${label}[${index}].data`);
    if (item.type === "command") {
      if (!Array.isArray(item.command) || item.command.length === 0 || item.command.some((part) => typeof part !== "string" || part === "")) corrupt(`${label}[${index}].command is invalid.`);
      if (typeof item.exitCode !== "number" || !Number.isSafeInteger(item.exitCode)) corrupt(`${label}[${index}].exitCode is invalid.`);
    } else if (item.command !== undefined || item.exitCode !== undefined) {
      corrupt(`${label}[${index}] command fields require type command.`);
    }
    return {
      id,
      type: item.type as ManifestTrace["type"],
      message: text(item.message, `${label}[${index}].message`),
      at: iso(item.at, `${label}[${index}].at`),
      ...(item.data === undefined ? {} : { data: item.data as Record<string, unknown> }),
      ...(item.command === undefined ? {} : { command: item.command as string[] }),
      ...(item.exitCode === undefined ? {} : { exitCode: item.exitCode as number }),
    };
  });
}

function parseResult(value: unknown, label: string): ManifestResult {
  const item = object(value, label);
  keys(item, ["decision", "summary", "handoff", "todo", "artifacts", "returnTo", "reasons", "authority"], ["decision", "summary", "handoff", "todo", "artifacts"], label);
  if (!["continue", "return", "accept", "rollback"].includes(item.decision as string)) corrupt(`${label}.decision is invalid.`);
  const summary = text(item.summary, `${label}.summary`);
  const handoff = text(item.handoff, `${label}.handoff`);
  if (item.reasons !== undefined && (!Array.isArray(item.reasons) || item.reasons.length === 0 || item.reasons.some((reason) => typeof reason !== "string" || reason.trim() === ""))) corrupt(`${label}.reasons must be a non-empty string array.`);
  const parsed: ManifestResult = {
    decision: item.decision as ManifestResult["decision"],
    summary,
    handoff,
    todo: parseResultTodo(item.todo, `${label}.todo`),
    artifacts: parseArtifacts(item.artifacts, `${label}.artifacts`),
    ...(item.returnTo === undefined ? {} : { returnTo: stageOf(item.returnTo, `${label}.returnTo`) }),
    ...(item.reasons === undefined ? {} : { reasons: item.reasons as string[] }),
    ...(item.authority === undefined ? {} : { authority: text(item.authority, `${label}.authority`) }),
  };
  return parsed;
}

function parseOrigin(value: unknown, label: string): WorkOrigin {
  const origin = object(value, label);
  keys(origin, ["createdAt", "followUpOf"], ["createdAt"], label);
  return {
    createdAt: iso(origin.createdAt, `${label}.createdAt`),
    ...(origin.followUpOf === undefined ? {} : { followUpOf: text(origin.followUpOf, `${label}.followUpOf`) }),
  };
}

function parseInitiative(value: unknown, label: string): WorkInitiative {
  const record = object(value, label);
  keys(record, ["id", "position"], ["id", "position"], label);
  const id = text(record.id, `${label}.id`);
  if (!INITIATIVE_ID.test(id)) corrupt(`${label}.id is invalid.`);
  const position = record.position;
  if (typeof position !== "number" || !Number.isSafeInteger(position) || position < 1) corrupt(`${label}.position must be a positive integer.`);
  return { id, position };
}

export function parseWorkManifest(value: unknown, expectedId?: string): WorkManifest {
  const manifest = object(value, "Work manifest");
  const fields = ["schemaVersion", "type", "work", "repository", "graph", "issue", "workflow", "attempts", "completion"];
  keys(manifest, fields, fields, "Work manifest");
  if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) corrupt("Work manifest schemaVersion is unsupported.");
  if (manifest.type !== MANIFEST_TYPE) corrupt("Work manifest type is invalid.");

  const work = object(manifest.work, "Work manifest work");
  const workFields = ["id", "title", "description", "issueType", "priority", "acceptance", "createdAt", "requestedBy", "initiative", "origin"];
  keys(work, workFields, workFields, "Work manifest work");
  const id = text(work.id, "Work manifest work.id");
  if (!WORK_ID.test(id)) corrupt("Work manifest work.id is invalid.");
  if (expectedId !== undefined && id !== expectedId) corrupt(`Work manifest does not match ${expectedId}.`);
  if (!WORK_PRIORITIES.includes(work.priority as WorkPriority)) corrupt("Work manifest work.priority is invalid.");
  if (!ISSUE_TYPES.includes(work.issueType as IssueType)) corrupt("Work manifest work.issueType is invalid.");
  if (typeof work.description !== "string") corrupt("Work manifest work.description must be a string.");
  const initiative = parseInitiative(work.initiative, "Work manifest work.initiative");
  if (!id.startsWith(`${initiative.id}.`)) corrupt("Work manifest work.id does not belong to its initiative.");
  const identity: WorkIdentity = {
    id,
    title: text(work.title, "Work manifest work.title"),
    description: work.description,
    issueType: work.issueType as IssueType,
    priority: work.priority as WorkPriority,
    acceptance: array(work.acceptance, "Work manifest work.acceptance").map((item, index) => text(item, `Work manifest work.acceptance[${index}]`)),
    createdAt: iso(work.createdAt, "Work manifest work.createdAt"),
    requestedBy: text(work.requestedBy, "Work manifest work.requestedBy"),
    initiative,
    origin: parseOrigin(work.origin, "Work manifest work.origin"),
  };

  const graphRaw = object(manifest.graph, "Work manifest graph");
  keys(graphRaw, ["blockedBy"], ["blockedBy"], "Work manifest graph");
  const blockedBy = array(graphRaw.blockedBy, "Work manifest graph.blockedBy").map((raw, index) => {
    const blocker = text(raw, `Work manifest graph.blockedBy[${index}]`);
    if (!WORK_ID.test(blocker)) corrupt(`Work manifest graph.blockedBy[${index}] is invalid.`);
    if (blocker === id) corrupt("Work manifest graph.blockedBy contains the Work itself.");
    return blocker;
  });
  if (new Set(blockedBy).size !== blockedBy.length) corrupt("Work manifest graph.blockedBy contains duplicates.");
  if (blockedBy.some((blocker, index) => index > 0 && blocker <= (blockedBy[index - 1] as string))) corrupt("Work manifest graph.blockedBy is not sorted.");

  const repository = object(manifest.repository, "Work manifest repository");
  keys(repository, ["baseRef", "createdFromCommit", "baselineCommit"], ["baseRef"], "Work manifest repository");
  if (typeof repository.baseRef !== "string" || !BRANCH_REF.test(repository.baseRef)) corrupt("Work manifest repository.baseRef is invalid.");
  if ((repository.createdFromCommit === undefined) !== (repository.baselineCommit === undefined)) corrupt("Work manifest repository records a branch baseline without its provenance.");
  if (repository.createdFromCommit !== undefined && (typeof repository.createdFromCommit !== "string" || !GIT_HASH.test(repository.createdFromCommit))) corrupt("Work manifest repository.createdFromCommit is invalid.");
  if (repository.baselineCommit !== undefined && (typeof repository.baselineCommit !== "string" || !GIT_HASH.test(repository.baselineCommit))) corrupt("Work manifest repository.baselineCommit is invalid.");

  let issue: ManifestIssue | null = null;
  if (manifest.issue !== null) {
    const raw = object(manifest.issue, "Work manifest issue");
    keys(raw, ["repository", "number"], ["repository", "number"], "Work manifest issue");
    const issueRepository = text(raw.repository, "Work manifest issue.repository");
    if (!/^[^/\s]+\/[^/\s]+$/.test(issueRepository)) corrupt("Work manifest issue.repository is invalid.");
    issue = { repository: issueRepository, number: count(raw.number, "Work manifest issue.number") };
  }

  const workflow = object(manifest.workflow, "Work manifest workflow");
  keys(workflow, ["state", "stage", "attempt", "updatedAt"], ["state", "stage", "attempt", "updatedAt"], "Work manifest workflow");
  if (!["ready", "active", "terminal"].includes(workflow.state as string)) corrupt("Work manifest workflow.state is invalid.");

  const attempts: ManifestAttempt[] = array(manifest.attempts, "Work manifest attempts").map((raw, index) => {
    const label = `Work manifest attempts[${index}]`;
    const attempt = object(raw, label);
    keys(attempt, ["stage", "attempt", "runId", "status", "execution", "startedAt", "finishedAt", "todo", "result", "traces", "verificationTarget", "verifiedCandidate", "telemetry"], ["stage", "attempt", "runId", "status", "execution", "startedAt", "todo"], label);
    if (!ATTEMPT_STATUSES.includes(attempt.status as AttemptStatus)) corrupt(`${label}.status is invalid.`);
    const runId = text(attempt.runId, `${label}.runId`);
    if (!UUID.test(runId)) corrupt(`${label}.runId is invalid.`);
    const execution = object(attempt.execution, `${label}.execution`);
    keys(execution, ["role", "harness", "model"], ["role", "harness", "model"], `${label}.execution`);
    const stage = stageOf(attempt.stage, `${label}.stage`);
    if (execution.role !== STAGE_ROLES[stage]) corrupt(`${label}.execution.role does not match its stage.`);
    const snapshotFields = ["attempt", "candidateCommit", "manifestCommit", "baselineCommit", "targetCommit", "policyHash"] as const;
    const snapshotOf = (value: unknown, snapshotLabel: string): VerificationSnapshot => {
      const snapshot = object(value, snapshotLabel);
      keys(snapshot, snapshotFields, snapshotFields, snapshotLabel);
      for (const field of ["candidateCommit", "manifestCommit", "baselineCommit", "targetCommit"] as const) {
        if (typeof snapshot[field] !== "string" || !GIT_HASH.test(snapshot[field])) corrupt(`${snapshotLabel}.${field} is invalid.`);
      }
      if (typeof snapshot.policyHash !== "string" || !/^[0-9a-f]{64}$/.test(snapshot.policyHash)) corrupt(`${snapshotLabel}.policyHash is invalid.`);
      return {
        attempt: count(snapshot.attempt, `${snapshotLabel}.attempt`),
        candidateCommit: snapshot.candidateCommit as string,
        manifestCommit: snapshot.manifestCommit as string,
        baselineCommit: snapshot.baselineCommit as string,
        targetCommit: snapshot.targetCommit as string,
        policyHash: snapshot.policyHash,
      };
    };
    const verificationTarget = attempt.verificationTarget === undefined ? undefined : snapshotOf(attempt.verificationTarget, `${label}.verificationTarget`);
    const verifiedCandidate = attempt.verifiedCandidate === undefined ? undefined : snapshotOf(attempt.verifiedCandidate, `${label}.verifiedCandidate`);
    return {
      stage,
      attempt: count(attempt.attempt, `${label}.attempt`),
      runId,
      status: attempt.status as AttemptStatus,
      execution: {
        role: text(execution.role, `${label}.execution.role`),
        harness: text(execution.harness, `${label}.execution.harness`),
        model: text(execution.model, `${label}.execution.model`),
      },
      startedAt: iso(attempt.startedAt, `${label}.startedAt`),
      todo: parseTodoItems(attempt.todo, `${label}.todo`),
      ...(attempt.finishedAt === undefined ? {} : { finishedAt: iso(attempt.finishedAt, `${label}.finishedAt`) }),
      ...(attempt.result === undefined ? {} : { result: parseResult(attempt.result, `${label}.result`) }),
      ...(attempt.traces === undefined ? {} : { traces: parseTraces(attempt.traces, `${label}.traces`) }),
      ...(verificationTarget === undefined ? {} : { verificationTarget }),
      ...(verifiedCandidate === undefined ? {} : { verifiedCandidate }),
      ...(attempt.telemetry === undefined ? {} : { telemetry: parseAttemptTelemetry(attempt.telemetry, `${label}.telemetry`) }),
    };
  });

  let completion: ManifestCompletion | null = null;
  if (manifest.completion !== null) {
    const raw = object(manifest.completion, "Work manifest completion");
    keys(raw, ["outcome", "via", "authority", "finalizedAt", "summary", "replacedBy"], ["outcome", "via", "authority", "finalizedAt", "summary"], "Work manifest completion");
    if (!WORK_OUTCOMES.includes(raw.outcome as WorkOutcome)) corrupt("Work manifest completion.outcome is invalid.");
    if (raw.via !== "ship" && raw.via !== "spec") corrupt("Work manifest completion.via is invalid.");
    if (typeof raw.summary !== "string") corrupt("Work manifest completion.summary must be a string.");
    const outcome = raw.outcome as WorkOutcome;
    const shipDecided = SHIP_OUTCOMES.includes(outcome as ShipOutcome);
    if (shipDecided !== (raw.via === "ship")) corrupt("Work manifest completion.via does not match its outcome.");
    let replacedBy: string[] | undefined;
    if (raw.replacedBy !== undefined) {
      if (outcome !== "superseded") corrupt("Work manifest completion.replacedBy requires the superseded outcome.");
      replacedBy = array(raw.replacedBy, "Work manifest completion.replacedBy").map((item, index) => {
        const replacement = text(item, `Work manifest completion.replacedBy[${index}]`);
        if (!WORK_ID.test(replacement)) corrupt(`Work manifest completion.replacedBy[${index}] is invalid.`);
        if (replacement === id) corrupt("Work manifest completion.replacedBy contains the Work itself.");
        return replacement;
      });
      if (replacedBy.length === 0) corrupt("Work manifest completion.replacedBy must not be empty.");
      if (new Set(replacedBy).size !== replacedBy.length) corrupt("Work manifest completion.replacedBy contains duplicates.");
    } else if (outcome === "superseded") corrupt("Work manifest completion.replacedBy is required for a superseded Work.");
    completion = {
      outcome,
      via: raw.via,
      authority: text(raw.authority, "Work manifest completion.authority"),
      finalizedAt: iso(raw.finalizedAt, "Work manifest completion.finalizedAt"),
      summary: raw.summary,
      ...(replacedBy === undefined ? {} : { replacedBy }),
    };
  }

  if ((completion !== null) !== (workflow.state === "terminal")) {
    corrupt("Work manifest completion and workflow state disagree.");
  }

  const parsed: WorkManifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    type: MANIFEST_TYPE,
    work: identity,
    repository: {
      baseRef: repository.baseRef,
      ...(repository.createdFromCommit === undefined ? {} : { createdFromCommit: repository.createdFromCommit as string }),
      ...(repository.baselineCommit === undefined ? {} : { baselineCommit: repository.baselineCommit as string }),
    },
    graph: { blockedBy },
    issue,
    workflow: {
      state: workflow.state as ManifestWorkflow["state"],
      stage: stageOf(workflow.stage, "Work manifest workflow.stage"),
      attempt: count(workflow.attempt, "Work manifest workflow.attempt"),
      updatedAt: iso(workflow.updatedAt, "Work manifest workflow.updatedAt"),
    },
    attempts,
    completion,
  };
  validateManifestSemantics(parsed);
  return parsed;
}

function validateManifestSemantics(manifest: WorkManifest): void {
  const runs = new Set<string>();
  const counts = new Map<Stage, number>();
  let expectedStage: Stage = "plan";
  let terminalSeen = false;
  const staleVerify = (attempt: ManifestAttempt | undefined): boolean => attempt?.stage === "verify"
    && attempt.status === "invalidated"
    && attempt.verificationTarget?.baselineCommit !== manifest.repository.baselineCommit;
  for (const [index, attempt] of manifest.attempts.entries()) {
    if (attempt.stage === "verify" && expectedStage === "ship" && staleVerify(manifest.attempts[index - 1])) expectedStage = "verify";
    if (terminalSeen || attempt.stage !== expectedStage) corrupt(`Work manifest attempts[${index}] is outside the lifecycle graph.`);
    if (runs.has(attempt.runId)) corrupt(`Work manifest attempts[${index}].runId is duplicated.`);
    runs.add(attempt.runId);
    const expected = (counts.get(attempt.stage) ?? 0) + 1;
    if (attempt.attempt !== expected) corrupt(`Work manifest attempts[${index}].attempt is out of sequence.`);
    counts.set(attempt.stage, expected);
    if (attempt.status === "active") {
      if (attempt.finishedAt !== undefined || attempt.result !== undefined) corrupt(`Work manifest attempts[${index}] is active but already concluded.`);
    } else if (attempt.status === "abandoned") {
      // Spec terminated the Work while this run was live. Its evidence stays
      // readable, but it never concluded and nothing may follow it.
      if (attempt.finishedAt === undefined) corrupt(`Work manifest attempts[${index}] was abandoned without a time.`);
      if (attempt.result !== undefined) corrupt(`Work manifest attempts[${index}] was abandoned but carries a result.`);
      terminalSeen = true;
    } else if (attempt.finishedAt === undefined || attempt.result === undefined) {
      corrupt(`Work manifest attempts[${index}] is missing its result.`);
    }
    if (attempt.result !== undefined) {
      const decision = attempt.result.decision;
      const declared = attempt.todo.map((item) => item.id);
      const answered = attempt.result.todo.map((item) => item.id);
      if (declared.length !== answered.length || declared.some((id, itemIndex) => id !== answered[itemIndex])) corrupt(`Work manifest attempts[${index}] result does not answer its todo.`);
      const contract = todoContractViolations(decision, attempt.result.todo);
      if (contract.length > 0) corrupt(`Work manifest attempts[${index}] violates the todo contract: ${contract.join("; ")}.`);
      if (attempt.stage === "ship") {
        if (!(["accept", "rollback"] as const).includes(decision as "accept" | "rollback") || attempt.result.authority === undefined) corrupt(`Work manifest attempts[${index}] has an invalid Ship result.`);
        if (attempt.status !== "completed") corrupt(`Work manifest attempts[${index}] has an invalid terminal status.`);
        terminalSeen = true;
      } else if (decision === "accept" || decision === "rollback" || attempt.result.authority !== undefined) corrupt(`Work manifest attempts[${index}] has an invalid non-Ship result.`);
      if (decision === "return") {
        if (attempt.result.returnTo === undefined || !RETURN_TARGETS[attempt.stage]?.includes(attempt.result.returnTo) || attempt.result.reasons === undefined) corrupt(`Work manifest attempts[${index}] has an invalid return.`);
        if (attempt.status !== "returned") corrupt(`Work manifest attempts[${index}] has an invalid returned status.`);
        expectedStage = attempt.result.returnTo;
      } else if (attempt.result.returnTo !== undefined || attempt.result.reasons !== undefined) corrupt(`Work manifest attempts[${index}] has return fields on a non-return result.`);
      else if (attempt.stage !== "ship") {
        if (decision !== "continue" || !["completed", "invalidated"].includes(attempt.status)) corrupt(`Work manifest attempts[${index}] has an invalid continuation.`);
        const nextStage: Stage | undefined = STAGES[STAGES.indexOf(attempt.stage) + 1];
        if (nextStage === undefined) corrupt(`Work manifest attempts[${index}] has no following stage.`);
        expectedStage = nextStage;
      }
      if (attempt.stage === "plan" && decision !== "continue") corrupt(`Work manifest attempts[${index}] has an invalid Plan decision.`);
    }
    if (attempt.verifiedCandidate !== undefined) {
      if (attempt.stage !== "verify" || !["completed", "invalidated"].includes(attempt.status) || attempt.result?.decision !== "continue") corrupt(`Work manifest attempts[${index}].verifiedCandidate is not a Verify result.`);
    }
    if ((attempt.stage === "verify") !== (attempt.verificationTarget !== undefined)) corrupt(`Work manifest attempts[${index}] verification target disagrees with its stage.`);
    if (attempt.verifiedCandidate !== undefined && JSON.stringify(attempt.verifiedCandidate) !== JSON.stringify(attempt.verificationTarget)) corrupt(`Work manifest attempts[${index}] verified a different candidate than it started with.`);
    if (attempt.stage === "verify" && attempt.status === "completed" && attempt.result?.decision === "continue" && attempt.verifiedCandidate === undefined) {
      corrupt(`Work manifest attempts[${index}] is missing its verified candidate.`);
    }
    if (attempt.stage === "verify" && attempt.result?.decision === "continue") {
      const hasEvidence = attempt.traces?.some((trace) => trace.type === "command" && trace.exitCode === 0) === true;
      if (!hasEvidence) corrupt(`Work manifest attempts[${index}] is missing successful Verify command evidence.`);
    }
  }
  const active = manifest.attempts.filter((attempt) => attempt.status === "active");
  if (active.length > 1 || (active.length === 1 && manifest.attempts.at(-1) !== active[0])) corrupt("Work manifest has an invalid active attempt.");
  if ((manifest.workflow.state === "active") !== (active.length === 1)) corrupt("Work manifest workflow and active attempt disagree.");
  const last = manifest.attempts.at(-1);
  if (manifest.workflow.state === "ready" && manifest.workflow.stage === "verify" && expectedStage === "ship" && staleVerify(last)) expectedStage = "verify";
  if (manifest.workflow.state === "active" && (last?.stage !== manifest.workflow.stage || last.attempt !== manifest.workflow.attempt)) corrupt("Work manifest workflow does not identify its active attempt.");

  // A Spec decision ends a Work wherever it stood, so the terminal workflow
  // records the stage it was stopped at rather than Ship.
  const specTerminal = manifest.completion?.via === "spec";
  if (!specTerminal) {
    if (manifest.workflow.state === "ready" && (terminalSeen || manifest.workflow.stage !== expectedStage || manifest.workflow.attempt !== (counts.get(expectedStage) ?? 0) + 1)) corrupt("Work manifest workflow does not match its lifecycle history.");
    if ((manifest.workflow.state === "terminal") !== terminalSeen) corrupt("Work manifest terminal state does not match its lifecycle history.");
  } else if (manifest.workflow.state !== "terminal") {
    corrupt("Work manifest records a Spec outcome without a terminal workflow.");
  }

  if (manifest.completion === null) return;
  if (manifest.completion.via === "spec") {
    if (last?.status === "active") corrupt("Work manifest was terminated by Spec while an attempt was still active.");
    if (manifest.workflow.stage !== (last?.stage ?? "plan")) corrupt("Work manifest terminal workflow does not identify where Spec stopped it.");
    return;
  }
  const ship = [...manifest.attempts].reverse().find((attempt) => attempt.stage === "ship" && attempt.status === "completed");
  const expected = ship?.result?.decision === "accept" ? "accepted" : ship?.result?.decision === "rollback" ? "rolled-back" : undefined;
  if (expected !== manifest.completion.outcome || ship?.result?.authority !== manifest.completion.authority) corrupt("Work manifest completion does not match its Ship result.");
  if (manifest.workflow.stage !== "ship" || manifest.workflow.attempt !== ship?.attempt) corrupt("Work manifest terminal workflow does not identify its Ship result.");
  if (manifest.completion.finalizedAt !== ship?.finishedAt || manifest.completion.summary !== ship?.result?.summary) corrupt("Work manifest completion details do not match its Ship result.");
}
