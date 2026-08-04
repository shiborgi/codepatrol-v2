import { CodepatrolError } from "./errors.js";
import type { AttemptTelemetry } from "./telemetry.js";
import { RETURN_TARGETS, STAGES, STAGE_ROLES, todoContractViolations, type ExecutionIdentity, type Stage, type TodoItem } from "./types.js";
import type { ManifestAttempt, ManifestResult, ManifestTrace, VerificationSnapshot, WorkManifest } from "./work-manifest.js";
import { finalize } from "./terminalization.js";

export type Transition =
  | { type: "start"; stage: Stage; runId: string; execution: ExecutionIdentity; todo: TodoItem[]; verificationTarget?: VerificationSnapshot; at: string }
  | {
    type: "finish";
    stage: Stage;
    runId: string;
    result: ManifestResult;
    traces?: ManifestTrace[];
    verifiedCandidate?: VerificationSnapshot;
    telemetry?: AttemptTelemetry;
    at: string;
  };

function invalid(message: string): never {
  throw new CodepatrolError("INVALID_TRANSITION", message);
}

export function stageAfter(stage: Stage): Stage {
  const next = STAGES[STAGES.indexOf(stage) + 1];
  if (next === undefined) invalid(`No stage follows ${stage}.`);
  return next;
}

/** Attempts already recorded at `stage`, which is what numbers the next one. */
export function nextAttemptAt(manifest: WorkManifest, stage: Stage): number {
  return manifest.attempts.filter((attempt) => attempt.stage === stage).length + 1;
}

/**
 * The single place the lifecycle rules live. Given a manifest and one
 * transition, produce the next manifest or refuse.
 *
 * Only the expected stage may start, one attempt is active at a time, and a
 * result must answer exactly the todo its own start declared.
 */
export function applyTransition(manifest: WorkManifest, transition: Transition): WorkManifest {
  if (manifest.workflow.state === "terminal") invalid(`Work is already terminal: ${manifest.work.id}.`);

  if (transition.type === "start") {
    if (manifest.workflow.state !== "ready" || transition.stage !== manifest.workflow.stage) {
      invalid(`Work expects ${manifest.workflow.state === "ready" ? manifest.workflow.stage : manifest.workflow.state}, not ${transition.stage} start.`);
    }
    if (transition.execution.role !== STAGE_ROLES[transition.stage]) {
      invalid(`${transition.stage} must run as role ${STAGE_ROLES[transition.stage]}.`);
    }
    if (transition.todo.length === 0) invalid("A step must declare at least one todo item.");
    const todoIds = new Set<string>();
    for (const item of transition.todo) {
      if (item.id.trim() === "" || item.title.trim() === "" || todoIds.has(item.id)) invalid("Todo items require unique non-empty ids and titles.");
      todoIds.add(item.id);
    }
    if ((transition.stage === "verify") !== (transition.verificationTarget !== undefined)) invalid("Only Verify start records a verification target, and it is required.");
    const attempt: ManifestAttempt = {
      stage: transition.stage,
      attempt: nextAttemptAt(manifest, transition.stage),
      runId: transition.runId,
      status: "active",
      execution: transition.execution,
      startedAt: transition.at,
      todo: transition.todo,
      ...(transition.verificationTarget === undefined ? {} : { verificationTarget: transition.verificationTarget }),
    };
    return {
      ...manifest,
      workflow: { state: "active", stage: transition.stage, attempt: attempt.attempt, updatedAt: transition.at },
      attempts: [...manifest.attempts, attempt],
    };
  }

  const active = manifest.attempts.at(-1);
  if (manifest.workflow.state !== "active" || active === undefined || active.status !== "active") {
    invalid(`No ${transition.stage} attempt is active.`);
  }
  if (active.stage !== transition.stage || active.runId !== transition.runId) {
    invalid(`Result does not belong to the active ${manifest.workflow.stage} run.`);
  }
  const declared = active.todo.map((item) => item.id);
  const answered = transition.result.todo.map((item) => item.id);
  if (declared.length !== answered.length || declared.some((id, index) => id !== answered[index])) {
    invalid("The result must answer exactly the todo the step declared, in order.");
  }

  const decision = transition.result.decision;
  if (transition.result.summary.trim() === "" || transition.result.handoff.trim() === "") invalid("A result requires a summary and handoff.");
  const contract = todoContractViolations(decision, transition.result.todo);
  if (contract.length > 0) invalid(`The result violates the todo contract: ${contract.join("; ")}.`);
  if (decision === "return" && (transition.result.returnTo === undefined || transition.result.reasons === undefined || transition.result.reasons.length === 0 || transition.result.reasons.some((reason) => reason.trim() === ""))) invalid("A return requires a legal target and concrete reasons.");
  if (decision !== "return" && (transition.result.returnTo !== undefined || transition.result.reasons !== undefined)) invalid("Only a return may include return fields.");
  if (transition.stage !== "ship" && transition.result.authority !== undefined) invalid("Only Ship may record authority.");
  if (transition.stage === "verify" && decision === "continue") {
    if (transition.verifiedCandidate === undefined) invalid("A successful Verify must identify the exact candidate.");
    const hasEvidence = transition.traces?.some((trace) => trace.type === "command" && trace.exitCode === 0) === true;
    if (!hasEvidence) invalid("A successful Verify requires a successful command trace.");
  } else if (transition.verifiedCandidate !== undefined) {
    invalid("Only a successful Verify may record a verified candidate.");
  }
  const finished: ManifestAttempt = {
    ...active,
    finishedAt: transition.at,
    result: transition.result,
    ...(transition.traces === undefined || transition.traces.length === 0 ? {} : { traces: transition.traces }),
    ...(transition.verifiedCandidate === undefined ? {} : { verifiedCandidate: transition.verifiedCandidate }),
    ...(transition.telemetry === undefined ? {} : { telemetry: transition.telemetry }),
    status: "completed",
  };

  if (transition.stage === "ship") {
    if (decision !== "accept" && decision !== "rollback") invalid(`Ship must decide accept or rollback, not ${decision}.`);
    const authority = transition.result.authority;
    if (authority === undefined || authority.trim() === "") invalid("A terminal decision requires an explicit authority.");
    // Terminalization is shared with Spec's supersede and cancel, so all four
    // outcomes end the same way.
    return finalize({ ...manifest, attempts: [...manifest.attempts.slice(0, -1), finished] }, {
      outcome: decision === "accept" ? "accepted" : "rolled-back",
      authority,
      summary: transition.result.summary,
      finalizedAt: transition.at,
    });
  }

  if (decision === "accept" || decision === "rollback") invalid(`Only ship may decide ${decision}.`);

  if (decision === "continue") {
    const stage = stageAfter(transition.stage);
    const attempts = [...manifest.attempts.slice(0, -1), finished];
    return {
      ...manifest,
      workflow: { state: "ready", stage, attempt: attempts.filter((item) => item.stage === stage).length + 1, updatedAt: transition.at },
      attempts,
    };
  }

  const target = transition.result.returnTo;
  if (target === undefined || !RETURN_TARGETS[transition.stage]?.includes(target)) {
    invalid(`${transition.stage} cannot return to ${String(target)}.`);
  }
  // A return discards every conclusion from the target stage onward, so a stale
  // approval cannot be reused to skip the work being redone.
  const attempts = [...manifest.attempts.slice(0, -1), { ...finished, status: "returned" as const }].map((attempt) =>
    attempt.status === "completed" && STAGES.indexOf(attempt.stage) >= STAGES.indexOf(target)
      ? { ...attempt, status: "invalidated" as const }
      : attempt,
  );
  return {
    ...manifest,
    workflow: { state: "ready", stage: target, attempt: attempts.filter((item) => item.stage === target).length + 1, updatedAt: transition.at },
    attempts,
  };
}
