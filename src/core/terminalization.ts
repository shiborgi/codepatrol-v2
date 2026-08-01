import { CodepatrolError } from "./errors.js";
import { SHIP_OUTCOMES, type ShipOutcome, type WorkOutcome } from "./types.js";
import type { WorkManifest } from "./work-manifest.js";

/**
 * The single way a Work ends.
 *
 * There are two callers — Ship deciding `accepted` or `rolled-back`, and Spec
 * deciding `superseded` or `cancelled` — and they used to build `completion`
 * independently. That meant one rule written twice, which is exactly how the
 * two paths drift. Everything terminal now goes through here: the attempt
 * history is preserved the same way, and a run that was still live is
 * abandoned the same way. What a Work leaves behind is the manifest itself —
 * its attempts, traces, results, and this outcome — not a second record built
 * on top of it.
 */

export interface TerminalizationInput {
  outcome: WorkOutcome;
  authority: string;
  summary: string;
  finalizedAt: string;
  /** Supersede only: the Works that take this one's place. */
  replacedBy?: string[];
}

export function finalize(manifest: WorkManifest, input: TerminalizationInput): WorkManifest {
  if (manifest.completion !== null) {
    throw new CodepatrolError("INVALID_TRANSITION", `Work ${manifest.work.id} is already terminal.`);
  }
  if (input.authority.trim() === "") {
    throw new CodepatrolError("INVALID_TRANSITION", "A terminal decision requires an explicit authority.");
  }
  const via = SHIP_OUTCOMES.includes(input.outcome as ShipOutcome) ? "ship" : "spec";
  if ((input.replacedBy !== undefined) !== (input.outcome === "superseded")) {
    throw new CodepatrolError("INVALID_TRANSITION", "Only a superseded Work names its replacements.");
  }

  // A run still live when Spec ends the Work never concluded. Keeping it as
  // `abandoned` preserves its evidence without letting it read as a result.
  const last = manifest.attempts.at(-1);
  const attempts = last?.status === "active"
    ? [...manifest.attempts.slice(0, -1), { ...last, status: "abandoned" as const, finishedAt: input.finalizedAt }]
    : manifest.attempts;
  const settled: WorkManifest = { ...manifest, attempts };

  return {
    ...settled,
    workflow: {
      state: "terminal",
      // Ship ends at Ship; a Spec decision ends wherever the Work stood.
      stage: via === "ship" ? "ship" : attempts.at(-1)?.stage ?? "plan",
      attempt: attempts.at(-1)?.attempt ?? manifest.workflow.attempt,
      updatedAt: input.finalizedAt,
    },
    completion: {
      outcome: input.outcome,
      via,
      authority: input.authority,
      finalizedAt: input.finalizedAt,
      summary: input.summary,
      ...(input.replacedBy === undefined ? {} : { replacedBy: input.replacedBy }),
    },
  };
}
