import { CodepatrolError } from "./errors.js";
import type { InitiativeDocument, WorkRef } from "./initiative-document.js";
import { assertAcyclic, graphDigest } from "./work-graph.js";
import type { WorkManifest } from "./work-manifest.js";
import type { IssueType, WorkPriority } from "./types.js";

export interface DocumentProblem {
  /** The Work the problem is about, when there is one. */
  work?: string;
  code: string;
  message: string;
}

export interface PlannedCreate {
  key: string;
  title: string;
  description: string;
  issueType: IssueType;
  priority: WorkPriority;
  acceptance: string[];
  blockedBy: WorkRef[];
  requestedBy?: string;
  followUpOf?: string;
}

export interface PlannedUpdate {
  workId: string;
  title?: string;
  description?: string;
  priority?: WorkPriority;
  acceptance?: string[];
  /** The final dependency set, when the document changed it. */
  blockedBy?: WorkRef[];
}

export interface PlannedTermination {
  workId: string;
  outcome: "superseded" | "cancelled";
  authority: string;
  summary: string;
  replacedBy?: WorkRef[];
}

export interface InitiativeDiff {
  creates: PlannedCreate[];
  updates: PlannedUpdate[];
  terminations: PlannedTermination[];
  counts: {
    creates: number;
    updates: number;
    dependenciesAdded: number;
    dependenciesRemoved: number;
    supersedes: number;
    cancels: number;
  };
}

type Mutability = "free" | "invalidating" | "protected" | "immutable";

function mutabilityOf(manifest: WorkManifest): Mutability {
  if (manifest.completion !== null) return "immutable";
  if (manifest.attempts.length === 0) return "free";
  const stage = manifest.workflow.stage;
  return stage === "build" || stage === "verify" || stage === "ship" ? "protected" : "invalidating";
}

/** Refinement must not rewrite the premise underneath a candidate. */
const REFINABLE: readonly Mutability[] = ["free", "invalidating"];
/** Ending a Work is not refinement: it is allowed through Build, Verify, and a live run. */
const ENDABLE: readonly Mutability[] = ["free", "invalidating", "protected"];

/**
 * Diffs a declarative Initiative document against the current graph.
 *
 * Creating, updating, and rewiring are what the diff computes; only what
 * destroys standing Work is explicit in the document — cancel, supersede, and
 * follow-up. A Work that disappears from the document is dropped silently only
 * when it has no content; with content it must be ended explicitly.
 *
 * `initiativeId` is the Initiative the document targets, or undefined when the
 * document mints a new one (which has no members to drop yet).
 */
export function diffInitiativeDocument(document: InitiativeDocument, manifests: readonly WorkManifest[], initiativeId: string | undefined): InitiativeDiff {
  const problems: DocumentProblem[] = [];
  const problem = (code: string, message: string, work?: string): void => {
    problems.push(work === undefined ? { code, message } : { work, code, message });
  };

  const observed = graphDigest(manifests);
  if (observed !== document.digest) {
    throw new CodepatrolError("DOCUMENT_REJECTED", "[STALE_DOCUMENT] The Work graph moved before this document was applied.", 1, {
      expected: `graph ${document.digest}`,
      observed: `graph ${observed}`,
      committed: ["nothing was applied; the Work graph is unchanged"],
      nextCommand: "codepatrol spec inspect",
    });
  }

  const byId = new Map(manifests.map((manifest) => [manifest.work.id, manifest]));
  const claimed = new Set<string>();
  const claim = (workId: string, what: string): boolean => {
    if (claimed.has(workId)) {
      problem("OVERLAPPING_ACTIONS", `${workId} is claimed by more than one action (${what}).`, workId);
      return false;
    }
    claimed.add(workId);
    return true;
  };
  const known = (workId: string, what: string): WorkManifest | undefined => {
    const manifest = byId.get(workId);
    if (manifest === undefined) problem("UNKNOWN_WORK", `${what} names a Work that does not exist locally: ${workId}.`, workId);
    return manifest;
  };
  /**
   * How a Work may be changed, given where it stands and what the action is.
   *
   * Refinement (a `works[id]` entry) needs the Work free of a candidate and
   * free of a live run: rewriting the premise underneath Build or Verify would
   * silently invalidate work already done. Ending a Work — cancel or supersede
   * — is not refinement: it is allowed through Build, Verify, and even a live
   * run, which is exactly why cancelling an active run preserves it as
   * `abandoned` rather than refusing the cancellation.
   */
  const requireMutable = (manifest: WorkManifest | undefined, allowed: readonly Mutability[], what: string): void => {
    if (manifest === undefined) return;
    const mutability = mutabilityOf(manifest);
    if (!allowed.includes(mutability)) {
      const reason = mutability === "immutable" ? `is terminal (${manifest.completion?.outcome ?? "terminal"})`
        : mutability === "protected" ? `is in ${manifest.workflow.stage} and must not be rewritten underneath its candidate`
          : `is in ${manifest.workflow.stage}`;
      problem("PROTECTED_WORK", `${what} cannot change ${manifest.work.id}: it ${reason}.`, manifest.work.id);
      return;
    }
    if (allowed === REFINABLE && manifest.workflow.state === "active") {
      problem("ACTIVE_WORK", `${what} cannot change ${manifest.work.id} while a ${manifest.workflow.stage} run is active.`, manifest.work.id);
    }
  };

  const creates: PlannedCreate[] = [];
  const createsByKey = new Map<string, PlannedCreate>();
  const updates: PlannedUpdate[] = [];
  const terminations: PlannedTermination[] = [];
  const terminatedIds = new Set<string>();
  let dependenciesAdded = 0;
  let dependenciesRemoved = 0;

  const refToken = (ref: WorkRef): string => ref.kind === "id" ? ref.id : `#${ref.key}`;
  const resolvable = (ref: WorkRef, what: string): boolean => {
    if (ref.kind === "id") return known(ref.id, what) !== undefined;
    if (!createsByKey.has(ref.key)) {
      problem("UNKNOWN_KEY", `${what} references #${ref.key}, which the document does not create.`, undefined);
      return false;
    }
    return true;
  };

  // Pass one: the declared Works — creates and updates.
  const declaredIds = new Set<string>();
  for (const work of document.works) {
    if (work.key !== undefined) {
      if (createsByKey.has(work.key)) {
        problem("DUPLICATE_KEY", `The document declares #${work.key} more than once.`, undefined);
        continue;
      }
      const create: PlannedCreate = {
        key: work.key,
        title: work.title,
        description: work.description,
        issueType: work.issueType,
        priority: work.priority,
        acceptance: work.acceptance,
        blockedBy: work.blockedBy,
        ...(work.requestedBy === undefined ? {} : { requestedBy: work.requestedBy }),
      };
      createsByKey.set(work.key, create);
      creates.push(create);
      continue;
    }
    const id = work.id as string;
    const manifest = known(id, "The document");
    // Naming an existing Work keeps it a member of the Initiative even when
    // nothing about it changes — the only way to survive Pass four without
    // restating fields the document never meant to touch.
    declaredIds.add(id);
    if (manifest === undefined || !claim(id, "the document")) continue;
    if (mutabilityOf(manifest) === "immutable") {
      problem("PROTECTED_WORK", `The document cannot change ${id}: it is terminal (${manifest.completion?.outcome ?? "terminal"}).`, id);
      continue;
    }
    const updated: PlannedUpdate = { workId: id };
    let changed = false;
    if (work.title !== manifest.work.title) { updated.title = work.title; changed = true; }
    if (work.description !== manifest.work.description) { updated.description = work.description; changed = true; }
    if (work.priority !== manifest.work.priority) { updated.priority = work.priority; changed = true; }
    if (JSON.stringify(work.acceptance) !== JSON.stringify(manifest.work.acceptance)) { updated.acceptance = work.acceptance; changed = true; }
    const declaredEdges = work.blockedBy.map(refToken).sort();
    const currentEdges = [...manifest.graph.blockedBy].sort();
    if (JSON.stringify(declaredEdges) !== JSON.stringify(currentEdges)) {
      updated.blockedBy = work.blockedBy;
      changed = true;
      for (const token of declaredEdges) if (!currentEdges.includes(token)) dependenciesAdded += 1;
      for (const token of currentEdges) if (!declaredEdges.includes(token)) dependenciesRemoved += 1;
    }
    // Mutability and the active-run rule guard refinement, not a bare mention:
    // restating a Work's current state to keep it declared must never be
    // blocked by a candidate it never touches or a run it never disturbs.
    if (changed) {
      requireMutable(manifest, REFINABLE, "The document");
      updates.push(updated);
    }
  }

  // Pass two: follow-ups are creates that name their source.
  for (const followUp of document.followUp) {
    const from = known(followUp.from, "The follow-up");
    if (from === undefined) continue;
    const key = followUp.key as string;
    if (createsByKey.has(key)) {
      problem("DUPLICATE_KEY", `The document declares #${key} more than once.`, undefined);
      continue;
    }
    const create: PlannedCreate = {
      key,
      title: followUp.title,
      description: followUp.description,
      issueType: followUp.issueType,
      priority: followUp.priority,
      acceptance: followUp.acceptance,
      blockedBy: followUp.blockedBy,
      followUpOf: followUp.from,
      ...(followUp.requestedBy === undefined ? {} : { requestedBy: followUp.requestedBy }),
    };
    createsByKey.set(key, create);
    creates.push(create);
  }

  // Pass three: explicit terminations.
  for (const cancel of document.cancel) {
    const manifest = known(cancel.workId, "The cancel");
    if (manifest === undefined || !claim(cancel.workId, "the cancel")) continue;
    requireMutable(manifest, ENDABLE, "The cancel");
    if (mutabilityOf(manifest) === "immutable") continue;
    terminations.push({ workId: cancel.workId, outcome: "cancelled", authority: cancel.authority, summary: cancel.reason });
    terminatedIds.add(cancel.workId);
  }
  for (const supersede of document.supersede) {
    const manifest = known(supersede.workId, "The supersede");
    if (manifest === undefined || !claim(supersede.workId, "the supersede")) continue;
    requireMutable(manifest, ENDABLE, "The supersede");
    if (mutabilityOf(manifest) === "immutable") continue;
    if (supersede.replacedBy.some((ref) => ref.kind === "id" && ref.id === supersede.workId)) {
      problem("SELF_REFERENCE", `The supersede of ${supersede.workId} names itself as a replacement.`, supersede.workId);
      continue;
    }
    supersede.replacedBy.forEach((ref) => resolvable(ref, "The supersede"));
    terminations.push({ workId: supersede.workId, outcome: "superseded", authority: supersede.authority, summary: supersede.rationale, replacedBy: supersede.replacedBy });
    terminatedIds.add(supersede.workId);
  }

  // Pass four: members of the target Initiative that the document no longer
  // declares are dropped — silently when content-free, refused otherwise.
  // Terminal members are history, not shape: the diff never touches them.
  if (initiativeId !== undefined) {
    for (const manifest of manifests) {
      if (manifest.work.initiative.id !== initiativeId) continue;
      if (manifest.completion !== null) continue;
      const id = manifest.work.id;
      if (declaredIds.has(id) || terminatedIds.has(id)) continue;
      if (manifest.attempts.length === 0) {
        if (!claim(id, "the drop")) continue;
        terminations.push({ workId: id, outcome: "cancelled", authority: "spec", summary: "Dropped by the initiative document." });
        terminatedIds.add(id);
      } else {
        problem("DROPPED_WORK", `The document drops ${id}, which has content; cancel or supersede it explicitly.`, id);
      }
    }
  }

  // Dependency references must resolve, and nothing may depend on itself.
  for (const create of creates) {
    for (const ref of create.blockedBy) {
      if (ref.kind === "key" && ref.key === create.key) {
        problem("SELF_DEPENDENCY", `#${create.key} cannot block itself.`, undefined);
        continue;
      }
      resolvable(ref, `The blockedBy of #${create.key}`);
    }
  }
  for (const update of updates) {
    if (update.blockedBy === undefined) continue;
    for (const ref of update.blockedBy) {
      if (ref.kind === "id" && ref.id === update.workId) {
        problem("SELF_DEPENDENCY", `${update.workId} cannot block itself.`, update.workId);
        continue;
      }
      resolvable(ref, `The blockedBy of ${update.workId}`);
    }
  }

  // The projected graph — terminations removed, creates and updates applied —
  // must be acyclic, including cycles that only exist once the document lands.
  const projected = new Map<string, string[]>();
  for (const manifest of manifests) {
    if (terminatedIds.has(manifest.work.id)) continue;
    projected.set(manifest.work.id, [...manifest.graph.blockedBy]);
  }
  for (const update of updates) {
    if (update.blockedBy === undefined || terminatedIds.has(update.workId)) continue;
    projected.set(update.workId, update.blockedBy.map(refToken));
  }
  for (const create of creates) {
    projected.set(`#${create.key}`, create.blockedBy.map(refToken));
  }
  try {
    assertAcyclic(projected);
  } catch (error) {
    if (error instanceof CodepatrolError && error.code === "GRAPH_CYCLE") problems.push({ code: "GRAPH_CYCLE", message: error.message });
    else throw error;
  }

  if (problems.length > 0) {
    const rendered = problems.map((item) => `${item.work === undefined ? "" : `${item.work}: `}[${item.code}] ${item.message}`).join("\n");
    throw new CodepatrolError("DOCUMENT_REJECTED", `The document was rejected:\n${rendered}`, 1, {
      expected: "a document every rule accepts",
      observed: `${problems.length} problem(s)`,
      committed: ["nothing was applied; the Work graph is unchanged"],
      nextCommand: "codepatrol spec validate --initiative <the corrected document.json>",
    });
  }

  const supersedes = terminations.filter((termination) => termination.outcome === "superseded").length;
  return {
    creates,
    updates,
    terminations,
    counts: {
      creates: creates.length,
      updates: updates.length,
      dependenciesAdded,
      dependenciesRemoved,
      supersedes,
      cancels: terminations.length - supersedes,
    },
  };
}
