import type { GitManifestStore } from "../adapters/manifest-store.js";
import type { Worktrees } from "../adapters/worktree.js";
import { CodepatrolError } from "../core/errors.js";
import { INITIATIVE_SCHEMA_VERSION, INITIATIVE_TYPE, slugOf, type Initiative } from "../core/initiative.js";
import { diffInitiativeDocument, type InitiativeDiff } from "../core/initiative-diff.js";
import type { InitiativeDocument, WorkRef } from "../core/initiative-document.js";
import type { WorkIdentity } from "../core/types.js";
import { normalizeBlockers, type WorkManifest } from "../core/work-manifest.js";
import { finalize } from "../core/terminalization.js";
import type { Clock } from "./work-service.js";
import { systemClock } from "./work-service.js";

export interface ApplySummary {
  documentId: string;
  summary: string;
  creates: number;
  updates: number;
  dependenciesAdded: number;
  dependenciesRemoved: number;
  supersedes: number;
  cancels: number;
  createdWorkIds?: string[];
  updatedWorkIds?: string[];
  terminatedWorkIds?: string[];
  /** The Initiative this apply created under (minted or existing). */
  initiative?: string;
  nextCommand: string | null;
}

export class WorkGraphService {
  constructor(
    private readonly store: GitManifestStore,
    private readonly worktrees: Worktrees,
    private readonly clock: Clock = systemClock,
  ) {}

  private async manifests(): Promise<WorkManifest[]> {
    return (await this.store.list()).map((revision) => revision.manifest);
  }

  /**
   * Resolves which Initiative this document targets, minting a new one when it
   * declares one. A Work cannot exist without an Initiative: a document that
   * creates Works without either is refused. Undefined when the document
   * changes nothing and no Initiative exists yet.
   */
  private async resolveInitiative(document: InitiativeDocument, creates: number): Promise<{ initiative: Initiative; minted: boolean } | undefined> {
    const existing = await this.store.listInitiatives();
    if (document.initiative !== undefined) {
      const taken = new Set(existing.map((item) => Number(item.id.slice("INIT-".length))));
      let n = 0;
      while (taken.has(n)) n += 1;
      const initiative: Initiative = {
        schemaVersion: INITIATIVE_SCHEMA_VERSION,
        type: INITIATIVE_TYPE,
        id: `INIT-${n}`,
        title: document.initiative.title,
        slug: slugOf(document.initiative.title),
        intent: document.initiative.intent,
        motivation: document.initiative.motivation,
        ordering: document.initiative.ordering,
        createdAt: this.clock.now().toISOString(),
      };
      return { initiative, minted: true };
    }
    if (existing.length === 0) {
      if (creates > 0) {
        throw new CodepatrolError("DOCUMENT_REJECTED", "Creating Works requires an Initiative; declare one.", 1, {
          expected: "an initiative declaration, or an existing Initiative to create under",
          observed: "no Initiative exists",
          committed: ["nothing was applied; the Work graph is unchanged"],
          nextCommand: "codepatrol initiative list",
        });
      }
      return undefined;
    }
    return { initiative: existing[existing.length - 1] as Initiative, minted: false };
  }

  /**
   * Positions are assigned in topological order at creation and never change:
   * new Works continue the Initiative's numbering after its current maximum.
   */
  private async nextPositions(initiativeId: string, creates: readonly { key: string; blockedBy: readonly WorkRef[] }[]): Promise<Map<string, number>> {
    const members = (await this.manifests()).filter((manifest) => manifest.work.initiative.id === initiativeId);
    let next = members.reduce((max, manifest) => Math.max(max, manifest.work.initiative.position), 0) + 1;
    const positions = new Map<string, number>();
    const pending = new Map(creates.map((create) => [create.key, create]));
    const keyBlockers = (create: { blockedBy: readonly WorkRef[] }): string[] =>
      create.blockedBy.filter((ref): ref is Extract<WorkRef, { kind: "key" }> => ref.kind === "key").map((ref) => ref.key);
    while (pending.size > 0) {
      const ready = [...pending.entries()]
        .filter(([key, create]) => keyBlockers(create).every((blocker) => blocker === key || !pending.has(blocker)))
        .map(([key]) => key)
        .sort();
      if (ready.length === 0) throw new CodepatrolError("DOCUMENT_REJECTED", "Work dependencies form a cycle.", 1);
      for (const key of ready) {
        positions.set(key, next);
        next += 1;
        pending.delete(key);
      }
    }
    return positions;
  }

  async validate(document: InitiativeDocument): Promise<ApplySummary> {
    const manifests = await this.manifests();
    const resolved = await this.resolveInitiative(document, document.works.filter((work) => work.key !== undefined).length + document.followUp.length);
    diffInitiativeDocument(document, manifests, resolved?.initiative.id);
    return { documentId: document.documentId, summary: document.summary, creates: 0, updates: 0, dependenciesAdded: 0, dependenciesRemoved: 0, supersedes: 0, cancels: 0, nextCommand: "codepatrol spec apply --initiative <the same file>" };
  }

  async apply(document: InitiativeDocument): Promise<ApplySummary> {
    const manifests = await this.manifests();
    const preflight = await this.resolveInitiative(document, document.works.filter((work) => work.key !== undefined).length + document.followUp.length);
    const plan = diffInitiativeDocument(document, manifests, preflight?.initiative.id);
    // Existing Works a document touches must belong to the Initiative it
    // targets: a document describes one Initiative, not the whole backlog.
    if (preflight !== undefined && !preflight.minted) {
      const byId = new Map(manifests.map((manifest) => [manifest.work.id, manifest]));
      const foreign: string[] = [];
      for (const id of [...document.works.filter((work) => work.id !== undefined).map((work) => work.id as string), ...document.cancel.map((cancel) => cancel.workId), ...document.supersede.map((supersede) => supersede.workId)]) {
        const manifest = byId.get(id);
        if (manifest !== undefined && manifest.work.initiative.id !== preflight.initiative.id) foreign.push(id);
      }
      if (foreign.length > 0) {
        throw new CodepatrolError("DOCUMENT_REJECTED", `The document targets ${preflight.initiative.id} but names Works of other Initiatives: ${foreign.join(", ")}.`, 1, {
          expected: `only Works of ${preflight.initiative.id}`,
          observed: foreign.join(", "),
          committed: ["nothing was applied; the Work graph is unchanged"],
        });
      }
    }
    const at = this.clock.now().toISOString();
    const resolved = preflight ?? await this.resolveInitiative(document, plan.creates.length);
    const positions = resolved === undefined
      ? new Map<string, number>()
      : await this.nextPositions(resolved.initiative.id, plan.creates.map((create) => ({ key: create.key, blockedBy: create.blockedBy })));
    const idByKey = new Map(plan.creates.map((create) => {
      const initiativeId = resolved?.initiative.id ?? "INIT-0";
      const position = positions.get(create.key);
      if (position === undefined) throw new CodepatrolError("STATE_CORRUPT", `Document key was validated but not positioned: #${create.key}.`);
      return [create.key, `${initiativeId}.${position}-${slugOf(create.title)}`];
    }));
    const resolve = (ref: WorkRef): string => {
      if (ref.kind === "id") return ref.id;
      const id = idByKey.get(ref.key);
      if (id === undefined) throw new CodepatrolError("STATE_CORRUPT", `Document key was validated but not minted: #${ref.key}.`);
      return id;
    };
    const creates = plan.creates.map((create) => {
      const id = idByKey.get(create.key) as string;
      const initiativeId = resolved?.initiative.id ?? "INIT-0";
      const position = positions.get(create.key) as number;
      const identity: WorkIdentity = {
        id,
        title: create.title,
        description: create.description,
        issueType: create.issueType,
        priority: create.priority,
        acceptance: create.acceptance,
        createdAt: at,
        requestedBy: create.requestedBy ?? "spec",
        initiative: { id: initiativeId, position },
        origin: { createdAt: at, ...(create.followUpOf === undefined ? {} : { followUpOf: create.followUpOf }) },
      };
      return { identity, blockedBy: normalizeBlockers(create.blockedBy.map(resolve), id) };
    });

    const terminationByWork = new Map(plan.terminations.map((item) => [item.workId, item]));
    const writes: Array<{ workId: string; subject: string; mutate(current: WorkManifest): WorkManifest }> = [];
    for (const update of plan.updates) {
      if (terminationByWork.has(update.workId)) continue;
      writes.push({
        workId: update.workId,
        subject: `spec(${update.workId}): refine`,
        mutate: (current) => {
          const invalidated = current.attempts.length === 0
            ? current.attempts
            : current.attempts.map((attempt) => attempt.status === "completed" ? { ...attempt, status: "invalidated" as const } : attempt);
          return {
            ...current,
            work: {
              ...current.work,
              ...(update.title === undefined ? {} : { title: update.title }),
              ...(update.description === undefined ? {} : { description: update.description }),
              ...(update.priority === undefined ? {} : { priority: update.priority }),
              ...(update.acceptance === undefined ? {} : { acceptance: update.acceptance }),
            },
            ...(update.blockedBy === undefined ? {} : { graph: { blockedBy: normalizeBlockers(update.blockedBy.map(resolve), update.workId) } }),
            workflow: invalidated === current.attempts
              ? { ...current.workflow, updatedAt: at }
              : { state: "ready", stage: "plan", attempt: invalidated.filter((attempt) => attempt.stage === "plan").length + 1, updatedAt: at },
            attempts: invalidated,
          };
        },
      });
    }
    for (const termination of plan.terminations) {
      writes.push({ workId: termination.workId, subject: `spec(${termination.workId}): ${termination.outcome}`, mutate: (current) => finalize(current, {
        outcome: termination.outcome,
        authority: termination.authority,
        summary: termination.summary,
        finalizedAt: at,
        ...(termination.replacedBy === undefined ? {} : { replacedBy: termination.replacedBy.map(resolve) }),
      }) });
    }
    const applied = await this.store.applyBatch({
      expectedGraphDigest: document.digest,
      ...(resolved === undefined || !resolved.minted ? {} : { initiative: resolved.initiative }),
      creates,
      writes,
      archives: plan.terminations.map((item) => item.workId),
      subject: `spec: ${document.documentId}`,
    });
    for (const termination of plan.terminations) await this.worktrees.remove(termination.workId);
    const createdWorkIds = creates.map((create) => create.identity.id);
    const terminatedWorkIds = plan.terminations.map((item) => item.workId);
    const updatedWorkIds = applied.revisions.map((revision) => revision.manifest.work.id).filter((id) => !createdWorkIds.includes(id) && !terminatedWorkIds.includes(id));
    return {
      documentId: document.documentId,
      summary: document.summary,
      ...plan.counts,
      createdWorkIds,
      updatedWorkIds,
      terminatedWorkIds,
      ...(applied.initiative !== undefined ? { initiative: applied.initiative.id } : (resolved !== undefined && creates.length > 0 ? { initiative: resolved.initiative.id } : {})),
      nextCommand: null,
    };
  }
}

/** The diff is exported for tests; the service stays the sole graph writer. */
export type { InitiativeDiff };
