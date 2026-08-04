import { readFile } from "node:fs/promises";
import path from "node:path";
import { skillContentDigest, type SkillManifest } from "../core/skill.js";
import { resolveComposition } from "../core/skill-resolution.js";
import type { AttemptTelemetry, TelemetryReport } from "../core/telemetry.js";
import type { Stage } from "../core/types.js";

/**
 * Best-effort attempt-telemetry collector.
 *
 * The Core never throws to callers: a collector that throws drops the field
 * and the transition, the stage result, and Ship proceed unchanged. This is
 * the privacy boundary's runtime guarantee: telemetry is observable, never
 * load-bearing.
 */
export interface TelemetryContext {
  stage: Stage;
  workId: string;
  /** The runtime path of the current run's input handoff. */
  handoffPath: string;
  /** The shipped skill manifests to resolve the stage composition against. */
  skillManifests: readonly SkillManifest[];
  /** The host capabilities the resolver was given. */
  hostCapabilities: readonly string[];
  /** What the harness handed to `complete --telemetry`, if anything. */
  report?: TelemetryReport;
}

export interface TelemetryCollector {
  collect(context: TelemetryContext): Promise<AttemptTelemetry>;
}

/**
 * The default collector: counts, sizes, and the harness report. Reads the
 * runtime handoff to derive context size, resolves the stage composition to
 * count skills and total their bytes, and folds the harness report for tools
 * and model. A failure in any step drops the field; a missing input file is
 * treated as zero context, not an error.
 */
export function makeDefaultCollector(shippedSkillsDirectory: string, manifests: readonly SkillManifest[]): TelemetryCollector {
  let tablePromise: Promise<Map<string, number>> | undefined;
  return {
    async collect(context) {
      const contextBytes = await readContextBytes(context.handoffPath);
      const contextSections = await readContextSections(context.handoffPath);
      const composition = resolveComposition(context.stage, context.skillManifests, [...context.hostCapabilities]);
      if (tablePromise === undefined) tablePromise = buildSkillByteTable(shippedSkillsDirectory, manifests);
      const table = await tablePromise;
      let skillBytes = 0;
      for (const entry of composition.skills) {
        skillBytes += table.get(entry.id) ?? 0;
      }
      return {
        skills: { count: composition.skills.length, bytes: skillBytes },
        context: { sections: contextSections, bytes: contextBytes },
        tools: context.report?.tools ?? "unavailable",
        model: context.report?.model ?? "unavailable",
      };
    },
  };
}

/**
 * Computes the bytes of every resolved skill's SKILL.md by reading from the
 * shipped skills directory. This is intentionally separate from the
 * per-attempt collector so the directory lookup happens once and the
 * per-attempt path is a sum, not a re-resolve.
 */
export async function buildSkillByteTable(shippedSkillsDirectory: string, manifests: readonly SkillManifest[]): Promise<Map<string, number>> {
  const entries = await Promise.all(manifests.map(async (manifest) => [manifest.id, await readSkillBytes(shippedSkillsDirectory, manifest.id, manifest.digest)] as const));
  return new Map(entries);
}

async function readSkillBytes(directory: string, id: string, expectedDigest: string): Promise<number> {
  const file = path.join(directory, id, "SKILL.md");
  const raw = await readFile(file);
  if (skillContentDigest(raw) !== expectedDigest) {
    throw new Error(`Skill ${id} digest does not match its SKILL.md bytes.`);
  }
  return Buffer.byteLength(raw, "utf8");
}

async function readContextBytes(handoffPath: string): Promise<number> {
  try {
    const raw = await readFile(handoffPath, "utf8");
    return Buffer.byteLength(raw, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

async function readContextSections(handoffPath: string): Promise<number> {
  try {
    const raw = await readFile(handoffPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return 0;
    return Object.keys(parsed as Record<string, unknown>).length;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}
