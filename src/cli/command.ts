import type { PublicationService } from "../application/publication.js";
import type { ProjectionWarning } from "../application/publication/reconcile.js";
import type { SpecService } from "../application/spec-service.js";
import type { InitiativeService } from "../application/initiative-service.js";
import type { WorkService } from "../application/work-service.js";
import type { InitService } from "../application/init-service.js";
import type { DoctorService } from "../application/doctor-service.js";
import { CodepatrolError } from "../core/errors.js";
import type { Stage } from "../core/types.js";

export interface CommandContext {
  works: Pick<WorkService, "list" | "show" | "graph" | "start" | "resume" | "trace" | "complete" | "checkout" | "inspect" | "refresh">;
  spec: Pick<SpecService, "inspect" | "validate" | "apply">;
  initiatives: Pick<InitiativeService, "list" | "show">;
  publication: Pick<PublicationService, "automatic">;
  initialization: Pick<InitService, "run">;
  doctor: Pick<DoctorService, "run">;
  workspace: string;
  setExitCode?(code: number): void;
}

export interface CommandSpec {
  name: "init" | "doctor" | "spec" | "work" | "initiative" | "skill" | "change" | "sync" | Stage;
  summary: string;
  usage: string[];
  run(context: CommandContext, args: string[]): Promise<unknown>;
}

export interface PublicationOutcome {
  state: "synchronized" | "skipped" | "failed";
  repository?: string;
  project?: { number: number; title: string; status?: string };
  warnings?: ProjectionWarning[];
  error?: string;
}

/**
 * Publication is a projection: it runs after the local fact exists and can
 * never undo it. A repository with no remote reports `skipped` and the
 * lifecycle is unaffected.
 */
export async function publish(context: CommandContext, workId?: string, strict = false): Promise<PublicationOutcome> {
  try {
    const result = await context.publication.automatic(workId === undefined ? {} : { workId });
    if (result === undefined) return { state: "skipped" };
    const status = workId === undefined ? undefined : result.project.statuses.find((item) => item.workId === workId)?.status;
    return {
      state: "synchronized",
      repository: result.repository,
      project: { number: result.project.number, title: result.project.title, ...(status === undefined ? {} : { status }) },
      ...(result.warnings.length === 0 ? {} : { warnings: result.warnings }),
    };
  } catch (error) {
    if (strict) throw error;
    return { state: "failed", error: error instanceof CodepatrolError ? error.code : "UNEXPECTED_ERROR" };
  }
}

export function published(result: unknown, publication: PublicationOutcome): unknown {
  return result !== null && typeof result === "object" && !Array.isArray(result)
    ? { ...(result as Record<string, unknown>), publication }
    : { result, publication };
}
