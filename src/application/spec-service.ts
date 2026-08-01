import type { GitManifestStore } from "../adapters/manifest-store.js";
import type { Worktrees } from "../adapters/worktree.js";
import type { InitiativeDocument } from "../core/initiative-document.js";
import { attackOrder, type AttackOrder } from "../core/waves.js";
import { buildGraph, graphDigest, type WorkGraph } from "../core/work-graph.js";
import type { Clock } from "./work-service.js";
import { systemClock } from "./work-service.js";
import { WorkGraphService, type ApplySummary } from "./work-graph-service.js";

export type { ApplySummary } from "./work-graph-service.js";

export interface SpecInspection {
  digest: string;
  graph: WorkGraph;
  /** The attack order derived from the graph: waves and the critical path. */
  order: AttackOrder;
  active: Array<{ workId: string; stage: string; attempt: number; runId: string }>;
  staleBaselines: string[];
  observedAt: string;
}

/** Spec presents the Initiative context; WorkGraphService is the sole graph writer. */
export class SpecService {
  private readonly graphService: WorkGraphService;

  constructor(
    private readonly store: GitManifestStore,
    private readonly worktrees: Worktrees,
    private readonly clock: Clock = systemClock,
    graphService?: WorkGraphService,
  ) {
    this.graphService = graphService ?? new WorkGraphService(store, worktrees, clock);
  }

  async inspect(): Promise<SpecInspection> {
    const revisions = await this.store.list();
    const manifests = revisions.map((revision) => revision.manifest);
    const base = await this.store.baseRef();
    const staleBaselines: string[] = [];
    for (const revision of revisions) {
      const manifest = revision.manifest;
      if (manifest.completion !== null) continue;
      const inspection = await this.worktrees.inspect(manifest.work.id, base, manifest.repository.createdFromCommit, manifest.repository.baselineCommit);
      if (inspection.baselineStale) staleBaselines.push(manifest.work.id);
    }
    return {
      digest: graphDigest(manifests),
      graph: buildGraph(manifests),
      order: attackOrder(manifests),
      active: manifests.filter((manifest) => manifest.workflow.state === "active").map((manifest) => {
        const attempt = manifest.attempts.at(-1);
        return { workId: manifest.work.id, stage: manifest.workflow.stage, attempt: manifest.workflow.attempt, runId: attempt?.runId ?? "" };
      }),
      staleBaselines,
      observedAt: this.clock.now().toISOString(),
    };
  }

  validate(document: InitiativeDocument): Promise<ApplySummary> {
    return this.graphService.validate(document);
  }

  apply(document: InitiativeDocument): Promise<ApplySummary> {
    return this.graphService.apply(document);
  }
}
