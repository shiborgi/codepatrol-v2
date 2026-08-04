import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";
import type { ChangeIntegration, IntegrationResult } from "../adapters/integration.js";
import type { GitManifestStore, ManifestRevision } from "../adapters/manifest-store.js";
import type { Worktrees } from "../adapters/worktree.js";
import { changeOf, type ChangeView } from "../core/change.js";
import { CodepatrolError } from "../core/errors.js";
import { applyTransition, nextAttemptAt } from "../core/lifecycle.js";
import type { SkillManifest } from "../core/skill.js";
import type { AttemptTelemetry, TelemetryReport } from "../core/telemetry.js";
import type { GitPort } from "./ports.js";
import { STAGE_ROLES, nextStepOf, type NextStep, type RepositoryInspection, type Stage, type TodoItem, type WorkIdentity, type WorkOutcome, type WorkStatus } from "../core/types.js";
import { assertBuildUnblocked, buildGraph, releasesDependents, type WorkGraph } from "../core/work-graph.js";
import { archiveRef, manifestPath, manifestRef, serializeManifest, workBranchRef, type ManifestArtifact, type ManifestResult, type ManifestTrace, type VerificationSnapshot, type WorkManifest } from "../core/work-manifest.js";
import { executorReservedOffenders } from "../core/paths.js";
import { VERIFY_POLICY_PATH } from "../core/verify-policy.js";
import { type TelemetryCollector, type TelemetryContext } from "./telemetry.js";
import { VerificationGate } from "./verification-gate.js";

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };
export const HANDOFF_SCHEMA_VERSION = 1;
export const HANDOFF_TYPE = "codepatrol-handoff";

export interface WorkView {
  identity: WorkIdentity;
  repository: { baseRef: string; branch: string | null; archiveRef: string; createdFromCommit: string | null; baselineCommit: string | null };
  state: "ready" | "active" | "terminal";
  stage: Stage;
  attempt: number;
  activeRunId?: string;
  outcome?: WorkOutcome;
  finalizedAt?: string;
  /** The Works that replace this one; superseded Works only. */
  replacedBy?: string[];
  /** Where the Work stands in the dependency graph. */
  graph: { status: WorkStatus; blockedBy: string[]; unresolvedBlockers: string[] };
  change: ChangeView;
  issue: WorkManifest["issue"];
  attempts: WorkManifest["attempts"];
  source: ManifestRevision["source"];
  nextCommand: string | null;
  nextStep: NextStep;
}

export interface StartResult {
  workId: string;
  stage: Stage;
  attempt: number;
  runId: string;
  role: string;
  /** Regenerable handoff; never authoritative. */
  inputFile: string;
  /** Inline derived handoff; `inputFile` is only a disposable cache. */
  handoff: HandoffV1;
  /** The Change branch, readable with `git show <ref>:<path>` without a checkout. */
  inspectionRef: string;
  /** Null until a stage needs a checkout, or `--worktree` forces one. */
  worktreeDirectory: string | null;
  nextCommand: string;
}

export interface HandoffV1 {
  schemaVersion: typeof HANDOFF_SCHEMA_VERSION;
  type: typeof HANDOFF_TYPE;
  work: WorkIdentity;
  issue: WorkManifest["issue"];
  run: { id: string; stage: Stage; attempt: number; role: string; harness: string; model: string; startedAt: string; todo: TodoItem[] };
  repository: { baseRef: string; branch: string | null; createdFromCommit: string | null; baselineCommit: string | null; manifestPath: string; worktreeDirectory: string | null; inspectionRef: string };
  change: ChangeView;
  inspection: RepositoryInspection;
  attempts: WorkManifest["attempts"];
  pathPolicy: { executorForbidden: string[]; artifactForbidden: string[] };
  trigger: unknown;
  availableResults: unknown[];
  returns: unknown[];
}

/** A trace as a caller submits it: Codepatrol assigns the id and the time. */
export type TraceInput = Omit<ManifestTrace, "at" | "id">;

export interface ArtifactRequest {
  path: string;
  kind: string;
  description?: string;
}

export interface ResultInput {
  decision: "continue" | "return" | "accept" | "rollback";
  summary: string;
  handoff: string;
  todo: Array<{ id: string; status: "completed" | "skipped" | "failed"; note?: string }>;
  artifacts: ArtifactRequest[];
  returnTo?: Stage;
  reasons?: string[];
  authority?: string;
}

function nextCommand(view: Omit<WorkView, "nextCommand" | "nextStep">, next: NextStep): string | null {
  if (next === "done") return null;
  if (next === "build" && view.graph.unresolvedBlockers.length > 0) {
    return `codepatrol work show ${view.graph.unresolvedBlockers[0] as string}`;
  }
  if (view.state === "ready") return `codepatrol ${next} start ${view.identity.id} --harness <harness> --model <model> --todo <todo.json>`;
  if (view.state === "active") return `codepatrol ${next} complete ${view.identity.id} --run ${view.activeRunId ?? "<run-id>"} --result <result.json>`;
  return null;
}

/**
 * The Work as callers see it. `unresolvedBlockers` is supplied by whoever knows
 * the blockers' outcomes, because a manifest alone cannot say whether its own
 * blockers landed.
 */
function viewOf(revision: ManifestRevision, unresolvedBlockers: string[] = []): WorkView {
  const manifest = revision.manifest;
  const active = manifest.attempts.at(-1);
  // A terminal Work's code lives under the archive name; the working branch is
  // gone, so it is reported only while the Work is still open.
  const hasWorkingBranch = revision.codeHead !== undefined && manifest.completion === null;
  const status: WorkStatus = manifest.completion !== null ? manifest.completion.outcome
    : manifest.workflow.state === "active" ? "active"
      : unresolvedBlockers.length > 0 ? "blocked" : "executable";
  const partial: Omit<WorkView, "nextCommand" | "nextStep"> = {
    identity: manifest.work,
    repository: {
      baseRef: manifest.repository.baseRef,
      branch: hasWorkingBranch ? workBranchRef(manifest.work.id) : null,
      archiveRef: archiveRef(manifest.work.id),
      createdFromCommit: manifest.repository.createdFromCommit ?? null,
      baselineCommit: manifest.repository.baselineCommit ?? null,
    },
    state: manifest.workflow.state,
    stage: manifest.workflow.stage,
    attempt: manifest.workflow.attempt,
    ...(manifest.workflow.state === "active" && active !== undefined ? { activeRunId: active.runId } : {}),
    ...(manifest.completion === null ? {} : {
      outcome: manifest.completion.outcome,
      finalizedAt: manifest.completion.finalizedAt,
      ...(manifest.completion.replacedBy === undefined ? {} : { replacedBy: [...manifest.completion.replacedBy] }),
    }),
    graph: { status, blockedBy: [...manifest.graph.blockedBy], unresolvedBlockers },
    change: changeOf(manifest, hasWorkingBranch),
    issue: manifest.issue,
    attempts: manifest.attempts,
    source: revision.source,
  };
  const nextStep = nextStepOf(manifest);
  return { ...partial, nextStep, nextCommand: nextCommand(partial, nextStep) };
}

export interface WorkServiceTelemetry {
  /** Optional collector; absent means no telemetry is recorded. */
  collector?: TelemetryCollector;
  /** Manifests used to resolve the stage composition. */
  skillManifests: readonly SkillManifest[];
  /** Host capabilities passed to the resolver. */
  hostCapabilities: readonly string[];
}

export class WorkService {
  private readonly verification: VerificationGate;

  constructor(
    private readonly store: GitManifestStore,
    private readonly worktrees: Worktrees,
    private readonly integration: ChangeIntegration,
    private readonly git: GitPort,
    private readonly clock: Clock = systemClock,
    private readonly workspace: string = store.workspace,
    private readonly telemetry?: WorkServiceTelemetry,
  ) {
    this.verification = new VerificationGate(git, worktrees, clock, (entry) => this.trace("verify", entry.data?.workId as string, entry.data?.runId as string, entry), workspace);
  }

  private async verifyPolicyAt(commit: string): Promise<{ policy: import("../core/verify-policy.js").VerifyPolicy; hash: string }> {
    return this.verification.policyAt(commit);
  }

  private runtimeRoot(workId: string): string {
    return path.join(this.workspace, ".codepatrol", "runtime", "works", workId, "current");
  }

  async list(): Promise<WorkView[]> {
    const revisions = await this.store.list();
    const unresolved = new Map(buildGraph(revisions.map((revision) => revision.manifest))
      .nodes.map((node) => [node.id, node.unresolvedBlockers]));
    return revisions.map((revision) => viewOf(revision, unresolved.get(revision.manifest.work.id) ?? []));
  }

  /** The whole dependency graph, with derived status and the executable frontier. */
  async graph(): Promise<WorkGraph> {
    return buildGraph((await this.store.list()).map((revision) => revision.manifest));
  }

  async show(workId: string): Promise<WorkView> {
    workId = await this.store.resolve(workId);
    const revision = await this.store.read(workId);
    return viewOf(revision, await this.unresolvedBlockerIds(revision.manifest));
  }

  /**
   * Reads only this Work's declared blockers, not the whole graph: `show` must
   * stay cheap in a repository with a large backlog. A blocker that no longer
   * exists locally is simply absent from the result, which the graph treats as
   * unresolved.
   */
  private async blockerManifests(manifest: WorkManifest): Promise<Map<string, WorkManifest>> {
    const found = new Map<string, WorkManifest>();
    for (const blocker of manifest.graph.blockedBy) {
      const revision = await this.store.read(blocker).catch((error: unknown) => {
        if (error instanceof CodepatrolError && error.code === "WORK_NOT_FOUND") return undefined;
        throw error;
      });
      if (revision !== undefined) found.set(blocker, revision.manifest);
    }
    return found;
  }

  private async unresolvedBlockerIds(manifest: WorkManifest): Promise<string[]> {
    const found = await this.blockerManifests(manifest);
    return manifest.graph.blockedBy.filter((blocker) => {
      const target = found.get(blocker);
      return target === undefined || !releasesDependents(target);
    });
  }

  async inspect(workId: string): Promise<RepositoryInspection> {
    workId = await this.store.resolve(workId);
    const { manifest } = await this.store.read(workId);
    return this.worktrees.inspect(workId, manifest.repository.baseRef, manifest.repository.createdFromCommit, manifest.repository.baselineCommit);
  }

  async refresh(workId: string): Promise<WorkView> {
    workId = await this.store.resolve(workId);
    return viewOf(await this.store.refresh(workId, this.clock.now().toISOString()));
  }

  /** Materializes the checkout on demand; a Work never depends on one existing. */
  async checkout(workId: string): Promise<string> {
    workId = await this.store.resolve(workId);
    const revision = await this.store.read(workId);
    const manifest = revision.manifest;
    if (manifest.workflow.state === "terminal") throw new CodepatrolError("INVALID_TRANSITION", `Work is terminal: ${workId}.`);
    const contents = serializeManifest(manifest);
    const cut = await this.worktrees.materialize(workId, manifest.repository.baseRef, contents);
    if (cut.cutFromBase !== undefined) {
      await this.store.update(workId, (current) => ({
        ...current.manifest,
        repository: { ...current.manifest.repository, createdFromCommit: cut.cutFromBase as string, baselineCommit: cut.cutFromBase as string },
      }), `codepatrol(${workId}): branch cut`);
    }
    const updated = await this.store.read(workId);
    return this.worktrees.attach(workId, serializeManifest(updated.manifest));
  }

  private async handoff(manifest: WorkManifest, stage: Stage, attempt: number, worktreeDirectory: string | null): Promise<HandoffV1> {
    const standing = manifest.attempts.filter((item) => item.status === "completed" && item.result !== undefined);
    const last = [...manifest.attempts].reverse().find((item) => item.result !== undefined && item.status !== "active");
    const active = manifest.attempts.at(-1);
    if (active === undefined || active.status !== "active" || active.stage !== stage) throw new CodepatrolError("STATE_CORRUPT", `Handoff requested without an active ${stage} attempt.`);
    const branch = manifest.repository.baselineCommit === undefined ? null : workBranchRef(manifest.work.id);
    return {
      schemaVersion: HANDOFF_SCHEMA_VERSION,
      type: HANDOFF_TYPE,
      work: manifest.work,
      issue: manifest.issue,
      run: { id: active.runId, stage, attempt, role: STAGE_ROLES[stage], harness: active.execution.harness, model: active.execution.model, startedAt: active.startedAt, todo: active.todo },
      repository: {
        baseRef: manifest.repository.baseRef,
        branch,
        createdFromCommit: manifest.repository.createdFromCommit ?? null,
        baselineCommit: manifest.repository.baselineCommit ?? null,
        manifestPath: manifestPath(manifest.work.id),
        worktreeDirectory,
        inspectionRef: branch ?? manifestRef(manifest.work.id),
      },
      change: changeOf(manifest, branch !== null),
      inspection: await this.worktrees.inspect(manifest.work.id, manifest.repository.baseRef, manifest.repository.createdFromCommit, manifest.repository.baselineCommit),
      attempts: manifest.attempts,
      pathPolicy: { executorForbidden: [".codepatrol", ".codepatrol/**"], artifactForbidden: [".codepatrol", ".codepatrol/**"] },
      trigger: last === undefined ? null : {
        fromStage: last.stage,
        decision: last.result?.decision,
        summary: last.result?.summary,
        handoff: last.result?.handoff,
        ...(last.result?.returnTo === undefined ? {} : { returnTo: last.result.returnTo }),
        ...(last.result?.reasons === undefined ? {} : { reasons: last.result.reasons }),
      },
      availableResults: standing.map((item) => ({ stage: item.stage, attempt: item.attempt, summary: item.result?.summary, handoff: item.result?.handoff, artifacts: item.result?.artifacts })),
      returns: manifest.attempts
        .filter((item) => item.status === "returned" && item.result !== undefined)
        .map((item) => ({ from: item.stage, attempt: item.attempt, to: item.result?.returnTo, reasons: item.result?.reasons })),
    };
  }

  async start(stage: Stage, workId: string, harness: string, model: string, todo: TodoItem[], _options: { worktree?: boolean } = {}): Promise<StartResult> {
    workId = await this.store.resolve(workId);
    if (harness.trim() === "" || model.trim() === "") throw new CodepatrolError("INVALID_INPUT", "Harness and model are required.");
    if (stage === "build") {
      const { manifest } = await this.store.read(workId);
      assertBuildUnblocked(manifest, await this.blockerManifests(manifest));
    }
    const runId = randomUUID();
    const at = this.clock.now().toISOString();
    const execution = { role: STAGE_ROLES[stage], harness: harness.trim(), model: model.trim() };

    // The branch materializes on the first stage run so every stage of this
    // Work attaches its own worktree and never shares the repository's main
    // checkout with another Work. It is cut from the base as it stands now and
    // the manifest is projected into the base so the record reaches it. A
    // backlog Work that has not started owns no branch; creation still
    // materializes nothing. The --worktree option is kept for compatibility
    // and is now a no-op: every stage attaches unconditionally.
    const before = await this.store.read(workId);
    if (before.manifest.workflow.state === "terminal") throw new CodepatrolError("INVALID_TRANSITION", `Work is terminal: ${workId}.`);
    if (before.codeHead === undefined) {
      await this.worktrees.materialize(workId, before.manifest.repository.baseRef, serializeManifest(before.manifest));
    }

    const revision = await this.store.update(
      workId,
      async (revision) => {
        const current = serializeManifest(revision.manifest);
        await this.worktrees.reconcileIfPresent(workId, current, current);
        let manifest = revision.manifest;
        if (manifest.repository.baselineCommit === undefined && revision.codeHead !== undefined) {
          const cutPoint = await this.git.mergeBase(revision.codeHead, await this.git.resolveCommit(manifest.repository.baseRef));
          manifest = { ...manifest, repository: { ...manifest.repository, createdFromCommit: cutPoint, baselineCommit: cutPoint } };
        }
        let verificationTarget: VerificationSnapshot | undefined;
        if (stage === "verify") {
          if (revision.codeHead === undefined) throw new CodepatrolError("INVALID_TRANSITION", `Verify requires a materialized Change branch: ${workId}.`);
          verificationTarget = await this.verification.pinTarget(manifest, revision.codeHead, revision.commit, nextAttemptAt(manifest, "verify"));
        }
        return applyTransition(manifest, { type: "start", stage, runId, execution, todo, ...(verificationTarget === undefined ? {} : { verificationTarget }), at });
      },
      `${stage}(${workId}): start`,
    );
    const manifest = revision.manifest;
    const worktreeDirectory = await this.worktrees.attach(workId, serializeManifest(manifest));

    const root = this.runtimeRoot(workId);
    await rm(root, { recursive: true, force: true });
    await mkdir(root, { recursive: true });
    const attempt = manifest.workflow.attempt;
    const inputFile = path.join(root, "input.json");
    const handoff = await this.handoff(manifest, stage, attempt, worktreeDirectory);
    await writeFile(inputFile, `${JSON.stringify(handoff, null, 2)}\n`, "utf8");
    await writeFile(path.join(root, "run.json"), `${JSON.stringify({ workId, stage, attempt, runId, ...execution, startedAt: at }, null, 2)}\n`, "utf8");

    return {
      workId,
      stage,
      attempt,
      runId,
      role: execution.role,
      inputFile: path.relative(this.workspace, inputFile),
      handoff,
      inspectionRef: handoff.repository.inspectionRef,
      worktreeDirectory,
      nextCommand: `codepatrol ${stage} complete ${workId} --run ${runId} --result <result.json>`,
    };
  }

  async resume(stage: Stage, workId: string): Promise<StartResult> {
    workId = await this.store.resolve(workId);
    const { manifest } = await this.store.read(workId);
    const active = manifest.attempts.at(-1);
    if (manifest.workflow.state !== "active" || active === undefined || active.status !== "active" || active.stage !== stage) {
      throw new CodepatrolError("INVALID_TRANSITION", `No ${stage} run is active for ${workId}.`);
    }
    const contents = serializeManifest(manifest);
    await this.worktrees.materialize(workId, manifest.repository.baseRef, contents);
    const worktreeDirectory = await this.worktrees.attach(workId, contents);
    const root = this.runtimeRoot(workId);
    await mkdir(root, { recursive: true });
    const inputFile = path.join(root, "input.json");
    const handoff = await this.handoff(manifest, stage, active.attempt, worktreeDirectory);
    await writeFile(inputFile, `${JSON.stringify(handoff, null, 2)}\n`, "utf8");
    await writeFile(path.join(root, "run.json"), `${JSON.stringify({ workId, stage, attempt: active.attempt, runId: active.runId, ...active.execution, startedAt: active.startedAt }, null, 2)}\n`, "utf8");
    return {
      workId,
      stage,
      attempt: active.attempt,
      runId: active.runId,
      role: active.execution.role,
      inputFile: path.relative(this.workspace, inputFile),
      handoff,
      inspectionRef: handoff.repository.inspectionRef,
      worktreeDirectory,
      nextCommand: `codepatrol ${stage} complete ${workId} --run ${active.runId} --result <result.json>`,
    };
  }

  /**
   * Buffers a trace for the active run. Entries are folded into the attempt at
   * `complete`, so the manifest gets one commit per transition rather than one
   * per trace.
   */
  async trace(stage: Stage, workId: string, runId: string, entry: TraceInput): Promise<ManifestTrace> {
    workId = await this.store.resolve(workId);
    const { manifest } = await this.store.read(workId);
    const active = manifest.attempts.at(-1);
    if (manifest.workflow.state !== "active" || active?.runId !== runId || active.stage !== stage) {
      throw new CodepatrolError("INVALID_TRANSITION", `Trace does not belong to the active ${stage} run.`);
    }
    const stored: ManifestTrace = { ...entry, id: randomBytes(6).toString("hex"), at: this.clock.now().toISOString() };
    const root = this.runtimeRoot(workId);
    await mkdir(root, { recursive: true });
    await appendFile(path.join(root, "trace.jsonl"), `${JSON.stringify(stored)}\n`, "utf8");
    return stored;
  }

  private async bufferedTraces(workId: string): Promise<ManifestTrace[]> {
    const file = path.join(this.runtimeRoot(workId), "trace.jsonl");
    const raw = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    return raw.split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line) as ManifestTrace);
  }

  /**
   * Collects attempt telemetry, best-effort. A missing collector, a missing
   * input handoff, or a throwing collector all drop the field — never the
   * transition, the result, or Ship. The handoff is read from the runtime root
   * before `runtimeRoot` is removed by `completeLocked`.
   */
  private async collectTelemetry(stage: Stage, workId: string, report: TelemetryReport | undefined): Promise<AttemptTelemetry | undefined> {
    if (this.telemetry?.collector === undefined) return undefined;
    const context: TelemetryContext = {
      stage,
      workId,
      handoffPath: path.join(this.runtimeRoot(workId), "input.json"),
      skillManifests: this.telemetry.skillManifests,
      hostCapabilities: this.telemetry.hostCapabilities,
      ...(report === undefined ? {} : { report }),
    };
    try {
      return await this.telemetry.collector.collect(context);
    } catch {
      return undefined;
    }
  }

  /**
   * Resolves a declared artifact to the blob committed on the Change branch.
   * Artifacts live in the Change, so they reach the base through the squash and
   * are content-addressed by git rather than snapshotted. Path shape is
   * validated before anything else, so a malformed request is refused even
   * where no branch exists yet.
   */
  private async resolveArtifacts(commit: string | undefined, requests: readonly ArtifactRequest[]): Promise<ManifestArtifact[]> {
    return Promise.all(requests.map(async (request) => {
      if (request.path === "." || request.path.startsWith("./") || request.path.startsWith("/") || request.path.split("/").includes("..")) {
        throw new CodepatrolError("UNSAFE_PATH", `Artifact path escapes the Change: ${request.path}.`);
      }
      if (executorReservedOffenders([request.path]).length > 0) throw new CodepatrolError("RESERVED_PATH", `Artifacts may not use Codepatrol-owned paths: ${request.path}.`);
      if (commit === undefined) {
        throw new CodepatrolError("ARTIFACT_NOT_COMMITTED", `Artifact ${request.path} requires a Change branch; request a worktree and commit it first.`);
      }
      const found = await this.git.resolvePath(commit, request.path);
      if (found.kind === "missing") {
        throw new CodepatrolError("ARTIFACT_NOT_COMMITTED", `Artifact ${request.path} is not committed on the Change branch; commit it before completing the step.`);
      }
      if (found.kind !== "blob") throw new CodepatrolError("INVALID_ARTIFACT", `Artifact ${request.path} resolves to ${found.type}, not a file blob.`);
      return { path: request.path, kind: request.kind, blob: found.blob, ...(request.description === undefined ? {} : { description: request.description }) };
    }));
  }

  /**
   * Integrates a Work whose decision was recorded but whose effect on the base
   * never landed — a crash or a refused precondition between the manifest
   * commit and the squash. The manifest is the record, so re-running ship
   * finishes the job rather than being refused as already terminal.
   */
  private async resumeIntegration(workId: string, runId: string): Promise<(WorkView & { integration: IntegrationResult }) | undefined> {
    const current = await this.store.read(workId);
    if (current.manifest.completion === null) return undefined;
    const shipRun = [...current.manifest.attempts].reverse().find((attempt) => attempt.stage === "ship");
    if (shipRun?.runId !== runId) return undefined;
    if (current.codeHead === undefined) {
      const baseRef = current.manifest.repository.baseRef;
      const base = await this.git.resolveCommit(baseRef);
      const outcome = current.manifest.completion.outcome;
      const integrated = outcome === "accepted" ? await this.git.findIntegrationCommit(baseRef, workId) : undefined;
      if (outcome === "accepted" && integrated === undefined) throw new CodepatrolError("STATE_CORRUPT", `Accepted Work ${workId} has no integration commit.`);
      const integration: IntegrationResult = {
        outcome,
        archiveRef: archiveRef(workId),
        archiveCommit: current.commit,
        baseRef,
        baseBefore: base,
        baseAfter: base,
        ...(integrated === undefined ? {} : { integrationCommit: integrated }),
      };
      return { ...viewOf(current), integration };
    }
    const integration = await this.integration.integrate({
      manifest: current.manifest,
      head: current.codeHead,
      ...(current.manifest.issue === null ? {} : { issue: current.manifest.issue.number }),
    });
    return { ...viewOf(await this.store.read(workId)), integration };
  }

  /** Paths the Change moved after a pinned candidate, ignoring its own ledger. */
  private async movedSince(candidate: string, head: string, workId: string): Promise<string[]> {
    return (await this.git.changedPaths(candidate, head)).filter((file) => file !== manifestPath(workId));
  }

  async complete(stage: Stage, workId: string, runId: string, input: ResultInput, options: { telemetry?: TelemetryReport } = {}): Promise<WorkView & { integration?: IntegrationResult }> {
    workId = await this.store.resolve(workId);
    return this.git.withLock(`work/${workId}`, () =>
      (["build", "verify", "ship"] as Stage[]).includes(stage)
        ? this.git.withLock("repository", () => this.completeLocked(stage, workId, runId, input, options))
        : this.completeLocked(stage, workId, runId, input, options),
    );
  }

  private async completeLocked(stage: Stage, workId: string, runId: string, input: ResultInput, options: { telemetry?: TelemetryReport } = {}): Promise<WorkView & { integration?: IntegrationResult }> {
    const observed = await this.store.read(workId);
    const prior = observed.manifest.attempts.find((attempt) => attempt.runId === runId && attempt.stage === stage && attempt.result !== undefined);
    if (prior?.result !== undefined) {
      const stored = {
        decision: prior.result.decision,
        summary: prior.result.summary,
        handoff: prior.result.handoff,
        todo: prior.result.todo,
        artifacts: prior.result.artifacts.map(({ blob: _blob, ...artifact }) => artifact),
        ...(prior.result.returnTo === undefined ? {} : { returnTo: prior.result.returnTo }),
        ...(prior.result.reasons === undefined ? {} : { reasons: prior.result.reasons }),
        ...(prior.result.authority === undefined ? {} : { authority: prior.result.authority }),
      };
      if (JSON.stringify(stored) !== JSON.stringify(input)) throw new CodepatrolError("RESULT_CONFLICT", `Run ${runId} was already completed with another result.`);
      if (stage === "ship") {
        const resumed = await this.resumeIntegration(workId, runId);
        if (resumed !== undefined) return resumed;
      }
      return viewOf(observed);
    }
    if (stage === "verify" && input.decision === "continue") {
      const active = observed.manifest.attempts.at(-1);
      const pinned = active?.verificationTarget;
      if (observed.manifest.workflow.state !== "active" || active?.stage !== "verify" || active.runId !== runId || pinned === undefined) {
        throw new CodepatrolError("INVALID_TRANSITION", `No Verify run ${runId} is active for ${workId}.`);
      }
      const { hash } = await this.verifyPolicyAt(pinned.candidateCommit);
      await this.verification.runRequiredCommands({
        workId,
        runId,
        attempt: active.attempt,
        candidateCommit: pinned.candidateCommit,
        policyHash: pinned.policyHash,
      }, pinned, hash);
    }
    const at = this.clock.now().toISOString();
    const traces = await this.bufferedTraces(workId);
    const telemetry = await this.collectTelemetry(stage, workId, options.telemetry);
    const revision = await this.store.update(
      workId,
      async (current) => {
        const manifest = current.manifest;
        const currentManifest = serializeManifest(manifest);
        await this.worktrees.reconcileIfPresent(workId, currentManifest, currentManifest);
        const inspection = await this.worktrees.inspect(workId, manifest.repository.baseRef, manifest.repository.createdFromCommit, manifest.repository.baselineCommit);
        const reserved = executorReservedOffenders(inspection.status.map((line) => line.slice(3).split(" -> ").at(-1) ?? ""));
        if (reserved.length > 0) throw new CodepatrolError("RESERVED_PATH", `The executor modified Codepatrol-owned paths: ${reserved.join(", ")}.`);
        if (stage === "build" || stage === "verify" || (stage === "ship" && input.decision === "accept")) {
          if (!inspection.clean) throw new CodepatrolError("GIT_DIRTY", `${stage} requires a clean Change worktree; commit or discard its pending files first.`);
        }
        const artifacts = await this.resolveArtifacts(current.codeHead, input.artifacts);
        const result: ManifestResult = {
          decision: input.decision,
          summary: input.summary,
          handoff: input.handoff,
          todo: input.todo,
          artifacts,
          ...(input.returnTo === undefined ? {} : { returnTo: input.returnTo }),
          ...(input.reasons === undefined ? {} : { reasons: input.reasons }),
          ...(input.authority === undefined ? {} : { authority: input.authority }),
        };
        let verifiedCandidate: VerificationSnapshot | undefined;
        const targetCommit = await this.git.resolveCommit(manifest.repository.baseRef);
        const codeHead = current.codeHead ?? current.commit;
        if (stage === "verify" && input.decision === "continue") {
          const active = manifest.attempts.at(-1);
          const pinned = active?.verificationTarget;
          if (pinned === undefined) throw new CodepatrolError("STATE_CORRUPT", "Verify has no pinned candidate.");
          await this.verification.assertCandidateFresh(pinned, manifest, codeHead, targetCommit, (candidate, head) => this.movedSince(candidate, head, workId));
          const { policy, hash } = await this.verifyPolicyAt(codeHead);
          this.verification.assertEvidence({
            workId,
            runId,
            attempt: pinned.attempt,
            candidateCommit: pinned.candidateCommit,
            policyHash: pinned.policyHash,
          }, pinned, policy, traces);
          if (hash !== pinned.policyHash) {
            throw new CodepatrolError("VERIFY_STALE", `${VERIFY_POLICY_PATH} changed during Verify; verify the candidate again under the current policy.`);
          }
          verifiedCandidate = pinned;
        }
        if (stage === "ship" && input.decision === "accept") {
          await this.verification.assertShipVerification(manifest, codeHead, targetCommit, (candidate, head) => this.movedSince(candidate, head, workId));
        }
        return applyTransition(manifest, {
          type: "finish",
          stage,
          runId,
          result,
          traces,
          ...(verifiedCandidate === undefined ? {} : { verifiedCandidate }),
          ...(telemetry === undefined ? {} : { telemetry }),
          at,
        });
      },
      `${stage}(${workId}): ${input.decision}`,
    );
    await rm(this.runtimeRoot(workId), { recursive: true, force: true });

    if (stage !== "ship") return viewOf(revision);

    if (revision.codeHead === undefined) {
      // A Work that ships without ever having content has nothing to integrate:
      // its terminal record is the manifest ref alone.
      return viewOf(await this.store.read(workId));
    }
    const integration = await this.integration.integrate({
      manifest: revision.manifest,
      head: revision.codeHead,
      ...(revision.manifest.issue === null ? {} : { issue: revision.manifest.issue.number }),
    });
    return { ...viewOf(await this.store.read(workId)), integration };
  }
}
