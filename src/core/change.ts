import type { Stage } from "./types.js";
import { archiveRef, workBranchRef, type ManifestAttempt, type VerificationSnapshot, type WorkManifest } from "./work-manifest.js";

/**
 * Where the delivery candidate stands.
 *
 * - `draft` — still being produced; not offered for integration.
 * - `ready` — verified and offered.
 * - `integrated` — integrated into the base as one squash commit.
 * - `closed` — rolled back; it exists only in its archive ref.
 */
export type ChangeState = "draft" | "ready" | "integrated" | "closed";

export interface ChangeVerdict {
  decision: "approved" | "passed" | "returned";
  attempt: number;
  at: string;
}

/**
 * The delivery candidate a Work produces. Every field is derived from the
 * manifest, so the Change cannot drift from the lifecycle that produced it.
 * The branch is null while the Work has no code: a branch exists only while
 * there is something for it to hold.
 */
export interface ChangeView {
  workId: string;
  branch: string | null;
  baseRef: string;
  archiveRef: string;
  state: ChangeState;
  review: ChangeVerdict | null;
  checks: ChangeVerdict | null;
  verification: VerificationSnapshot | null;
}

/** The most recent attempt at `stage` whose conclusion still stands. */
function standingAttempt(manifest: WorkManifest, stage: Stage): ManifestAttempt | undefined {
  return [...manifest.attempts].reverse().find((attempt) =>
    attempt.stage === stage && attempt.status !== "invalidated" && attempt.status !== "active" && attempt.result !== undefined,
  );
}

function verdict(manifest: WorkManifest, stage: Stage, approved: "approved" | "passed"): ChangeVerdict | null {
  const attempt = standingAttempt(manifest, stage);
  if (attempt?.result === undefined || attempt.finishedAt === undefined) return null;
  return {
    decision: attempt.result.decision === "continue" ? approved : "returned",
    attempt: attempt.attempt,
    at: attempt.finishedAt,
  };
}

export function changeState(manifest: WorkManifest): ChangeState {
  if (manifest.completion?.outcome === "rolled-back") return "closed";
  if (manifest.completion?.outcome === "accepted") return "integrated";
  // Verification is what offers the Change; a return to build or plan retracts it.
  return verdict(manifest, "verify", "passed")?.decision === "passed" ? "ready" : "draft";
}

export function changeOf(manifest: WorkManifest, hasBranch = true): ChangeView {
  return {
    workId: manifest.work.id,
    branch: hasBranch ? workBranchRef(manifest.work.id) : null,
    baseRef: manifest.repository.baseRef,
    archiveRef: archiveRef(manifest.work.id),
    state: changeState(manifest),
    review: verdict(manifest, "review", "approved"),
    checks: verdict(manifest, "verify", "passed"),
    verification: standingAttempt(manifest, "verify")?.verifiedCandidate ?? null,
  };
}
