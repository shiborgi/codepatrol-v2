import type { WorkManifest } from "./work-manifest.js";

export interface Wave {
  /** 1-based: wave 1 is what could run immediately. */
  wave: number;
  works: string[];
}

export interface BlockedView {
  workId: string;
  /** Each unresolved blocker, with the wave it sits in, or null when it never releases. */
  blockers: Array<{ id: string; wave: number | null }>;
}

export interface AttackOrder {
  /**
   * Topological levels over the open graph. Every Work in a wave has all of
   * its blockers accepted or in an earlier wave. A Work whose blocker was
   * rolled back, superseded, or cancelled never appears: nothing releases it.
   */
  waves: Wave[];
  /** The longest dependency chain, blocker first. */
  criticalPath: string[];
  /** Open Works that are not executable yet, naming what blocks them. */
  blocked: BlockedView[];
}

/**
 * Derives the attack order from the graph alone: what could run together, and
 * in which waves. Running Works concurrently stays out of scope — this says
 * what *could* run together, nothing more. Terminal Works are satisfied
 * history when accepted, and permanent blockers otherwise.
 */
export function attackOrder(manifests: readonly WorkManifest[]): AttackOrder {
  const open = manifests.filter((manifest) => manifest.completion === null);
  const byId = new Map(manifests.map((manifest) => [manifest.work.id, manifest]));
  const accepted = (id: string): boolean => byId.get(id)?.completion?.outcome === "accepted";

  const waveOf = new Map<string, number>();
  const visiting = new Set<string>();

  const visit = (id: string): number | undefined => {
    const cached = waveOf.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) return undefined;
    visiting.add(id);
    const manifest = byId.get(id);
    if (manifest === undefined || manifest.completion !== null) {
      visiting.delete(id);
      return undefined;
    }
    let level = 1;
    for (const blocker of manifest.graph.blockedBy) {
      if (accepted(blocker)) continue;
      const blockerWave = visit(blocker);
      if (blockerWave === undefined) {
        // A blocker that is missing or never accepted never releases this
        // Work, so it belongs to no wave.
        visiting.delete(id);
        return undefined;
      }
      level = Math.max(level, blockerWave + 1);
    }
    visiting.delete(id);
    waveOf.set(id, level);
    return level;
  };

  for (const manifest of open) visit(manifest.work.id);

  const waves: Wave[] = [];
  for (const [id, level] of [...waveOf.entries()].sort((left, right) => left[0].localeCompare(right[0]))) {
    const wave = waves.find((candidate) => candidate.wave === level);
    if (wave === undefined) waves.push({ wave: level, works: [id] });
    else wave.works.push(id);
  }
  waves.sort((left, right) => left.wave - right.wave);

  // The critical path is the longest chain among wave-eligible Works, walking
  // dependents forward from each wave-1 root.
  const dependents = new Map<string, string[]>();
  for (const [id] of waveOf) {
    for (const blocker of (byId.get(id) as WorkManifest).graph.blockedBy) {
      if (!waveOf.has(blocker)) continue;
      dependents.set(blocker, [...(dependents.get(blocker) ?? []), id]);
    }
  }
  let criticalPath: string[] = [];
  const walk = (id: string, path: string[]): void => {
    const next = [...path, id];
    if (next.length > criticalPath.length) criticalPath = next;
    for (const dependent of dependents.get(id) ?? []) walk(dependent, next);
  };
  for (const [id, level] of waveOf) {
    if (level === 1) walk(id, []);
  }

  const blocked: BlockedView[] = [];
  for (const manifest of [...open].sort((left, right) => left.work.id.localeCompare(right.work.id))) {
    const unresolved = manifest.graph.blockedBy.filter((blocker) => !accepted(blocker));
    if (unresolved.length === 0) continue;
    blocked.push({
      workId: manifest.work.id,
      blockers: unresolved.sort().map((id) => ({ id, wave: waveOf.get(id) ?? null })),
    });
  }

  return { waves, criticalPath, blocked };
}
