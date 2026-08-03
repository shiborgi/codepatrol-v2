import { CodepatrolError } from "./errors.js";
import { SKILL_ID } from "./identifiers.js";
import { sha256 } from "./json.js";
import type { SkillManifest } from "./skill.js";
import type { Stage } from "./types.js";

/**
 * Resolves a stage's skill composition deterministically.
 *
 * Resolution is selection, not governance. Core invariants, Work state, and
 * repository policy outrank any skill a manifest might declare: a secondary
 * may add method and never alter lifecycle decisions or return rules.
 * Precedence lives in prose at the call sites that take a decision, not here.
 *
 * The resolver is a pure function of the inputs. Given the same `manifests`
 * and `hostCapabilities`, it returns the same ordered `skills` and the same
 * `digest`, so the result can be cached by `digest` and any change to a
 * resolved skill's recorded digest is visible in the composition digest.
 */
export interface SkillCompositionEntry {
  id: string;
  version: string;
  kind: SkillManifest["kind"];
  digest: string;
}

export interface SkillCompositionReason {
  id: string;
  reason: string;
}

export interface SkillComposition {
  stage: Stage;
  /** Stage skill first, then secondaries in ascending id order. Fixed forever. */
  skills: readonly SkillCompositionEntry[];
  /** sha256 over the canonical JSON of `skills`. */
  digest: string;
  /** Every included skill with the reason it joined the composition. */
  included: readonly SkillCompositionReason[];
  /** Recommended skills absent from the resolved set, with the reason each was dropped. */
  omitted: readonly SkillCompositionReason[];
}

function fail(code: "SKILL_UNRESOLVABLE" | "SKILL_CONFLICT" | "SKILL_CAPABILITY_UNMET", message: string): never {
  throw new CodepatrolError(code, message);
}

function validatedManifests(manifests: readonly SkillManifest[]): readonly SkillManifest[] {
  for (const manifest of manifests) {
    if (!SKILL_ID.test(manifest.id)) fail("SKILL_UNRESOLVABLE", `Skill manifest id is not a valid skill id: ${manifest.id}.`);
  }
  return manifests;
}

function selectStageSkill(stage: Stage, manifests: readonly SkillManifest[]): SkillManifest {
  const target = `codepatrol-${stage}`;
  const matches = manifests.filter((manifest) => manifest.id === target);
  if (matches.length === 1) return matches[0] as SkillManifest;
  fail(
    "SKILL_UNRESOLVABLE",
    matches.length === 0
      ? `No skill matches the stage skill id ${target}.`
      : `Multiple skills match the stage skill id ${target}: ${matches.length} manifests.`,
  );
}

/**
 * Sort included skill ids deterministically: stage skill first, then
 * secondaries in ascending id order. The order is part of the contract — the
 * resolution digest is computed over this order, so changing it changes the
 * digest and downstream caches.
 */
function orderedIncludes(stage: SkillManifest, included: ReadonlyMap<string, SkillManifest>): SkillManifest[] {
  const stageEntry = included.get(stage.id);
  if (stageEntry === undefined) fail("SKILL_UNRESOLVABLE", `Stage skill ${stage.id} is not in the resolved composition.`);
  const secondaries: SkillManifest[] = [];
  for (const [id, manifest] of included) {
    if (id !== stage.id) secondaries.push(manifest);
  }
  secondaries.sort((left, right) => left.id.localeCompare(right.id));
  return [stageEntry, ...secondaries];
}

/** Pick the smallest-id source from a list of source ids. */
function smallestId(ids: readonly string[]): string {
  return [...ids].sort((left, right) => left.localeCompare(right))[0] as string;
}

export function resolveComposition(stage: Stage, manifests: readonly SkillManifest[], hostCapabilities: readonly string[]): SkillComposition {
  validatedManifests(manifests);
  const stageSkill = selectStageSkill(stage, manifests);
  const byId = new Map<string, SkillManifest>();
  for (const manifest of manifests) byId.set(manifest.id, manifest);

  const included = new Map<string, SkillManifest>();
  const reasons = new Map<string, string>();
  included.set(stageSkill.id, stageSkill);
  reasons.set(stageSkill.id, `the stage skill for ${stage}`);

  // Closure over `requires`: each pass pulls in unfulfilled requirements.
  // The reason for a required skill is the smallest-id source that required it,
  // recorded the first time the skill joined (a later requirement still applies
  // but does not change the recorded reason — it is a stable label, not a
  // history). A skill requiring itself or naming an unknown id refuses.
  const requiredBy = new Map<string, string[]>();
  let progress = true;
  while (progress) {
    progress = false;
    const snapshot = Array.from(included.keys()).sort();
    for (const id of snapshot) {
      const manifest = included.get(id) as SkillManifest;
      for (const requiredId of manifest.requires ?? []) {
        if (requiredId === id) fail("SKILL_UNRESOLVABLE", `Skill ${id} requires itself.`);
        if (included.has(requiredId)) continue;
        const requiredManifest = byId.get(requiredId);
        if (requiredManifest === undefined) {
          fail("SKILL_UNRESOLVABLE", `Skill ${id} requires ${requiredId}, which is not in the manifest set.`);
        }
        included.set(requiredId, requiredManifest);
        const sources = requiredBy.get(requiredId) ?? [];
        sources.push(id);
        requiredBy.set(requiredId, sources);
        if (!reasons.has(requiredId)) {
          reasons.set(requiredId, `required by ${smallestId(sources)}`);
        }
        progress = true;
      }
    }
  }

  // Recommends: walk included skills in id order so the recommend walk is
  // deterministic; record a recommend-included reason only the first time the
  // skill joined. Skills recommended but absent from the manifest set land in
  // `omitted` with their reason.
  const snapshotForRecommends = Array.from(included.keys()).sort();
  const omitted: SkillCompositionReason[] = [];
  for (const id of snapshotForRecommends) {
    const manifest = included.get(id) as SkillManifest;
    for (const recommendedId of manifest.recommends ?? []) {
      if (included.has(recommendedId)) continue;
      const recommendedManifest = byId.get(recommendedId);
      if (recommendedManifest === undefined) {
        omitted.push({ id: recommendedId, reason: `recommended by ${id}, not available` });
        continue;
      }
      included.set(recommendedId, recommendedManifest);
      if (!reasons.has(recommendedId)) {
        reasons.set(recommendedId, `recommended by ${id}`);
      }
    }
  }

  for (const id of Array.from(included.keys())) {
    const manifest = included.get(id) as SkillManifest;
    for (const conflictId of manifest.conflicts ?? []) {
      if (!included.has(conflictId) || conflictId === id) continue;
      fail("SKILL_CONFLICT", `Skill ${id} conflicts with ${conflictId}; both are included in the composition.`);
    }
  }

  const hostSet = new Set(hostCapabilities);
  for (const manifest of included.values()) {
    for (const capability of manifest.capabilities) {
      if (!hostSet.has(capability)) {
        fail("SKILL_CAPABILITY_UNMET", `Skill ${manifest.id} requires host capability ${capability}, which is not provided.`);
      }
    }
  }

  const ordered = orderedIncludes(stageSkill, included);
  const entries: SkillCompositionEntry[] = ordered.map((manifest) => ({
    id: manifest.id,
    version: manifest.version,
    kind: manifest.kind,
    digest: manifest.digest,
  }));
  const digest = sha256(JSON.stringify(entries));

  const includedReasons: SkillCompositionReason[] = ordered.map((manifest) => ({
    id: manifest.id,
    reason: reasons.get(manifest.id) as string,
  }));

  const omittedSorted = [...omitted].sort((left, right) => left.id.localeCompare(right.id));

  return {
    stage,
    skills: entries,
    digest,
    included: includedReasons,
    omitted: omittedSorted,
  };
}