import type { GitManifestStore } from "../adapters/manifest-store.js";
import { initiativeOfWork, type Initiative } from "../core/initiative.js";
import { attackOrder, type AttackOrder } from "../core/waves.js";
import { buildGraph, type WorkGraph } from "../core/work-graph.js";

export interface InitiativeWorkView {
  id: string;
  title: string;
  stage: import("../core/types.js").Stage;
  status: import("../core/types.js").WorkStatus;
}

export interface InitiativeView {
  initiative: Initiative;
  works: InitiativeWorkView[];
  graph: WorkGraph;
  /** The attack order over this Initiative's Works, wave numbers global. */
  order: AttackOrder;
}

/**
 * Reads Initiatives and derives their Works from identifiers. Membership is
 * never stored: `INIT-<n>.<p>-<slug>` already names its home, so there is no
 * member list to keep in sync and nothing that can disagree with the graph.
 */
export class InitiativeService {
  constructor(private readonly store: GitManifestStore) {}

  async list(): Promise<Initiative[]> {
    return this.store.listInitiatives();
  }

  async show(id: string): Promise<InitiativeView> {
    const initiative = await this.store.readInitiative(id);
    const manifests = (await this.store.list()).map((revision) => revision.manifest);
    const members = manifests.filter((manifest) => initiativeOfWork(manifest.work.id) === initiative.id);
    const graph = buildGraph(manifests);
    const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
    const works = members.map((manifest) => {
      const node = nodeById.get(manifest.work.id);
      return {
        id: manifest.work.id,
        title: manifest.work.title,
        stage: manifest.workflow.stage,
        status: node?.status ?? (manifest.completion !== null ? manifest.completion.outcome : "executable"),
      };
    }).sort((left, right) => left.id.localeCompare(right.id));
    const memberIds = new Set(members.map((manifest) => manifest.work.id));
    const global = attackOrder(manifests);
    const order: AttackOrder = {
      waves: global.waves
        .map((wave) => ({ wave: wave.wave, works: wave.works.filter((id) => memberIds.has(id)) }))
        .filter((wave) => wave.works.length > 0),
      criticalPath: global.criticalPath.filter((id) => memberIds.has(id)),
      blocked: global.blocked.filter((entry) => memberIds.has(entry.workId)),
    };
    return { initiative, works, graph, order };
  }
}
