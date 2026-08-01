import { CodepatrolError } from "./errors.js";
import { sha256 } from "./json.js";
import type { Stage, WorkPriority, WorkStatus } from "./types.js";
import type { WorkManifest } from "./work-manifest.js";

/**
 * A stable fingerprint of everything a document could have depended on.
 *
 * A document that says "supersede W because it is still in Plan" is wrong the
 * moment W reaches Build. Rather than guess which fields matter, the digest
 * covers every field the validator reads, so any relevant movement makes the
 * document stale.
 */
export function graphDigest(manifests: readonly WorkManifest[]): string {
  const canonical = [...manifests]
    .sort((left, right) => left.work.id.localeCompare(right.work.id))
    .map((manifest) => JSON.stringify({
      work: manifest.work,
      repository: manifest.repository,
      workflow: manifest.workflow,
      attempts: manifest.attempts,
      graph: { blockedBy: [...manifest.graph.blockedBy].sort() },
      completion: manifest.completion,
    }))
    .join("\u001e");
  return sha256(canonical);
}

/**
 * The dependency graph over Works, derived from manifests rather than stored.
 *
 * Every edge lives on the dependent's manifest, so the graph is the union of
 * what each Work says about itself. There is no second ledger to disagree with.
 */

export interface WorkNode {
  id: string;
  title: string;
  priority: WorkPriority;
  stage: Stage;
  status: WorkStatus;
  blockedBy: string[];
  blocks: string[];
  /** Blockers that are not accepted; non-empty means Build cannot start. */
  unresolvedBlockers: string[];
}

export interface WorkGraph {
  nodes: WorkNode[];
  /** Ready, non-terminal Works whose every blocker is accepted. */
  executable: string[];
}

/**
 * Where one Work stands, ignoring its blockers.
 *
 * A Work is terminal by its recorded outcome, active while a run is live, and
 * otherwise merely ready. Blocking is a property of the graph, so `buildGraph`
 * upgrades `executable` to `blocked` once it can see the blockers' outcomes.
 */
function localStatus(manifest: WorkManifest): WorkStatus {
  if (manifest.completion !== null) return manifest.completion.outcome;
  return manifest.workflow.state === "active" ? "active" : "executable";
}

/** Whether this Work releases the Works that depend on it. Only accept does. */
export function releasesDependents(manifest: WorkManifest): boolean {
  return manifest.completion?.outcome === "accepted";
}

/**
 * Refuses a cycle, naming the Works that form it.
 *
 * Cycles are checked over a plain edge map rather than manifests so a proposed
 * graph can be validated before any of it is written.
 */
export function assertAcyclic(edges: ReadonlyMap<string, readonly string[]>): void {
  const visiting = new Set<string>();
  const settled = new Set<string>();
  const path: string[] = [];

  const walk = (id: string): void => {
    if (settled.has(id)) return;
    if (visiting.has(id)) {
      const start = path.indexOf(id);
      throw new CodepatrolError("GRAPH_CYCLE", `Work dependencies form a cycle: ${[...path.slice(start), id].join(" -> ")}.`);
    }
    visiting.add(id);
    path.push(id);
    for (const blocker of edges.get(id) ?? []) walk(blocker);
    path.pop();
    visiting.delete(id);
    settled.add(id);
  };

  for (const id of [...edges.keys()].sort()) walk(id);
}

/** Every Work that transitively blocks `id`. */
export function transitiveBlockers(edges: ReadonlyMap<string, readonly string[]>, id: string): Set<string> {
  const found = new Set<string>();
  const pending = [...(edges.get(id) ?? [])];
  while (pending.length > 0) {
    const next = pending.pop() as string;
    if (found.has(next)) continue;
    found.add(next);
    pending.push(...(edges.get(next) ?? []));
  }
  return found;
}

export function edgesOf(manifests: readonly WorkManifest[]): Map<string, string[]> {
  return new Map(manifests.map((manifest) => [manifest.work.id, [...manifest.graph.blockedBy]]));
}

export function buildGraph(manifests: readonly WorkManifest[]): WorkGraph {
  const byId = new Map(manifests.map((manifest) => [manifest.work.id, manifest]));
  const edges = edgesOf(manifests);
  assertAcyclic(edges);

  const blocks = new Map<string, string[]>();
  for (const manifest of manifests) {
    for (const blocker of manifest.graph.blockedBy) {
      blocks.set(blocker, [...(blocks.get(blocker) ?? []), manifest.work.id].sort());
    }
  }

  const nodes = manifests.map((manifest): WorkNode => {
    // A blocker Codepatrol cannot see locally is unresolved by definition: the
    // local manifests are the only authority on dependency state.
    const unresolved = manifest.graph.blockedBy.filter((blocker) => {
      const target = byId.get(blocker);
      return target === undefined || !releasesDependents(target);
    });
    const local = localStatus(manifest);
    return {
      id: manifest.work.id,
      title: manifest.work.title,
      priority: manifest.work.priority,
      stage: manifest.workflow.stage,
      status: local === "executable" && unresolved.length > 0 ? "blocked" : local,
      blockedBy: [...manifest.graph.blockedBy],
      blocks: blocks.get(manifest.work.id) ?? [],
      unresolvedBlockers: unresolved,
    };
  }).sort((left, right) => left.id.localeCompare(right.id));

  return { nodes, executable: nodes.filter((node) => node.status === "executable").map((node) => node.id) };
}

/**
 * Refuses to start Build while a blocker is unresolved.
 *
 * Plan and Review deliberately run while blocked — understanding and reviewing
 * a change does not depend on its blocker having landed. Build does, because
 * its result is a candidate that would be verified against the wrong base.
 */
export function assertBuildUnblocked(manifest: WorkManifest, blockers: ReadonlyMap<string, WorkManifest>): void {
  const unresolved = manifest.graph.blockedBy.filter((blocker) => {
    const target = blockers.get(blocker);
    return target === undefined || !releasesDependents(target);
  });
  if (unresolved.length === 0) return;
  const detail = unresolved.map((blocker) => {
    const target = blockers.get(blocker);
    const state = target === undefined ? "not found locally" : target.completion?.outcome ?? "not accepted";
    return `${blocker} (${state})`;
  });
  throw new CodepatrolError("WORK_BLOCKED", `Build requires every blocker to be accepted; unresolved: ${detail.join(", ")}.`, 1, {
    expected: `every blocker of ${manifest.work.id} accepted`,
    observed: detail.join(", "),
    committed: ["nothing was started; Plan and Review remain available while blocked"],
    nextCommand: `codepatrol work show ${unresolved[0] as string}`,
  });
}
