import assert from "node:assert/strict";
import test from "node:test";
import { changeOf, changeState } from "../core/change.js";
import { CodepatrolError } from "../core/errors.js";
import { applyTransition, nextAttemptAt, stageAfter } from "../core/lifecycle.js";
import { STAGE_ROLES, type Stage } from "../core/types.js";
import { createManifest, parseWorkManifest, serializeManifest, type ManifestResult, type VerificationSnapshot, type WorkManifest } from "../core/work-manifest.js";
import { TEST_ORIGIN } from "./support/fixtures.js";

const IDENTITY = {
  id: "INIT-0.1-fix-authentication",
  title: "Fix authentication",
  description: "Correct token refresh behavior",
  issueType: "Bug" as const,
  priority: "p1" as const,
  acceptance: ["The behaviour is demonstrably correct"],
  createdAt: "2026-07-31T03:00:00.000Z",
  requestedBy: "github:owner/repository#42",
  initiative: { id: "INIT-0", position: 1 },
  origin: TEST_ORIGIN,
};
const BASE = "a".repeat(40);
const CANDIDATE = "b".repeat(40);
const MANIFEST_COMMIT = "d".repeat(40);
const POLICY_HASH = "c".repeat(64);

/** The snapshot Verify pins; `attempt` tracks which Verify attempt made it. */
function snapshot(attempt = 1): VerificationSnapshot {
  return { attempt, candidateCommit: CANDIDATE, manifestCommit: MANIFEST_COMMIT, baselineCommit: BASE, targetCommit: BASE, policyHash: POLICY_HASH };
}
const TODO = [{ id: "T1", title: "Do the work" }];
const DONE = [{ id: "T1", status: "completed" as const }];

let clock = 0;
function at(): string {
  clock += 1;
  return new Date(Date.UTC(2026, 6, 31, 4, 0, clock)).toISOString();
}

function runId(seed: number): string {
  return `${String(seed).padStart(8, "0")}-1111-4222-8333-444444444444`;
}

function fresh(): WorkManifest {
  return createManifest({ identity: IDENTITY, baseRef: "refs/heads/main" });
}

function start(manifest: WorkManifest, stage: Stage, seed = manifest.attempts.length + 1): WorkManifest {
  return applyTransition(manifest, {
    type: "start",
    stage,
    runId: runId(seed),
    execution: { role: STAGE_ROLES[stage], harness: "test", model: "test-model" },
    todo: TODO,
    ...(stage === "verify" ? { verificationTarget: snapshot(manifest.attempts.filter((item) => item.stage === "verify").length + 1) } : {}),
    at: at(),
  });
}

function finish(manifest: WorkManifest, stage: Stage, result: Partial<ManifestResult> = {}): WorkManifest {
  const active = manifest.attempts.at(-1);
  const completed = { decision: "continue" as const, summary: `${stage} done`, handoff: "next", todo: DONE, artifacts: [], ...result };
  return applyTransition(manifest, {
    type: "finish",
    stage,
    runId: active?.runId ?? runId(0),
    result: completed,
    ...(stage === "verify" && completed.decision === "continue" ? {
      traces: [{ id: "a1b2c3d4e5f6", type: "command" as const, message: "Tests passed", command: ["npm", "test"], exitCode: 0, at: at() }],
      verifiedCandidate: active?.verificationTarget ?? snapshot(),
    } : {}),
    at: at(),
  });
}

function through(manifest: WorkManifest, stages: readonly Stage[], perStage: Partial<Record<Stage, Partial<ManifestResult>>> = {}): WorkManifest {
  return stages.reduce((current, stage) => finish(start(current, stage), stage, perStage[stage] ?? {}), manifest);
}

test("starts at plan and refuses any other stage first", () => {
  const manifest = fresh();
  assert.equal(manifest.workflow.stage, "plan");
  assert.deepEqual(manifest.repository, { baseRef: "refs/heads/main" }, "a new Work has no branch and therefore no baseline");

  for (const stage of ["review", "build", "verify", "ship"] as const) {
    assert.throws(() => start(manifest, stage), (error: unknown) => error instanceof CodepatrolError && error.code === "INVALID_TRANSITION", stage);
  }
  assert.equal(start(manifest, "plan").workflow.state, "active");
});

test("refuses a second attempt while one is active", () => {
  const active = start(fresh(), "plan");
  assert.throws(() => start(active, "plan"), (error: unknown) => error instanceof CodepatrolError && error.code === "INVALID_TRANSITION");
});

test("binds a result to the run and the todo its own start declared", () => {
  const active = start(fresh(), "plan");

  assert.throws(
    () => applyTransition(active, { type: "finish", stage: "plan", runId: runId(99), result: { decision: "continue", summary: "s", handoff: "h", todo: DONE, artifacts: [] }, at: at() }),
    (error: unknown) => error instanceof CodepatrolError && error.code === "INVALID_TRANSITION",
  );
  assert.throws(
    () => finish(active, "plan", { todo: [{ id: "OTHER", status: "completed" }] }),
    (error: unknown) => error instanceof CodepatrolError && error.code === "INVALID_TRANSITION",
  );
  assert.throws(
    () => finish(active, "plan", { todo: [...DONE, { id: "T2", status: "completed" }] }),
    (error: unknown) => error instanceof CodepatrolError && error.code === "INVALID_TRANSITION",
  );
});

test("requires the stage's own role", () => {
  assert.throws(
    () => applyTransition(fresh(), { type: "start", stage: "plan", runId: runId(1), execution: { role: "builder", harness: "h", model: "m" }, todo: TODO, at: at() }),
    (error: unknown) => error instanceof CodepatrolError && error.code === "INVALID_TRANSITION",
  );
});

test("advances one stage at a time through the whole lifecycle", () => {
  const shipped = through(fresh(), ["plan", "review", "build", "verify"], {});
  assert.equal(shipped.workflow.stage, "ship");
  assert.equal(shipped.workflow.state, "ready");

  const terminal = finish(start(shipped, "ship"), "ship", { decision: "accept", authority: "release-owner" });
  assert.equal(terminal.workflow.state, "terminal");
  assert.equal(terminal.completion?.outcome, "accepted");
  assert.equal(terminal.completion?.authority, "release-owner");
  assert.deepEqual(terminal.attempts.map((attempt) => attempt.execution.role), ["planner", "reviewer", "builder", "verifier", "shipper"]);
});

test("only ship may reach a terminal decision, and it needs an authority", () => {
  const planning = start(fresh(), "plan");
  assert.throws(
    () => finish(planning, "plan", { decision: "accept", authority: "someone" }),
    (error: unknown) => error instanceof CodepatrolError && error.code === "INVALID_TRANSITION",
  );

  const shipping = start(through(fresh(), ["plan", "review", "build", "verify"]), "ship");
  assert.throws(
    () => finish(shipping, "ship", { decision: "continue" }),
    (error: unknown) => error instanceof CodepatrolError && error.code === "INVALID_TRANSITION",
  );
  assert.throws(
    () => finish(shipping, "ship", { decision: "accept" }),
    (error: unknown) => error instanceof CodepatrolError && error.code === "INVALID_TRANSITION",
  );
});

test("a return invalidates every standing conclusion from the target onward", () => {
  const verifying = start(through(fresh(), ["plan", "review", "build"]), "verify");
  const returned = finish(verifying, "verify", { decision: "return", returnTo: "plan", reasons: ["premise not demonstrated"] });

  assert.equal(returned.workflow.stage, "plan");
  assert.equal(returned.workflow.state, "ready");
  // The verify attempt returned; plan, review, and build lose their standing.
  assert.deepEqual(
    returned.attempts.map((attempt) => `${attempt.stage}:${attempt.status}`),
    ["plan:invalidated", "review:invalidated", "build:invalidated", "verify:returned"],
  );
  // Attempt numbering continues rather than restarting.
  assert.equal(returned.workflow.attempt, 2);
  assert.equal(nextAttemptAt(returned, "plan"), 2);
});

test("a return to a later stage leaves earlier conclusions standing", () => {
  const verifying = start(through(fresh(), ["plan", "review", "build"]), "verify");
  const returned = finish(verifying, "verify", { decision: "return", returnTo: "build", reasons: ["tests fail"] });

  assert.deepEqual(
    returned.attempts.map((attempt) => `${attempt.stage}:${attempt.status}`),
    ["plan:completed", "review:completed", "build:invalidated", "verify:returned"],
  );
  assert.equal(returned.workflow.stage, "build");
});

test("enforces the exact return matrix", () => {
  const stages = ["plan", "review", "build", "verify", "ship"] as const;
  const before: Readonly<Record<Stage, readonly Stage[]>> = {
    plan: [],
    review: ["plan"],
    build: ["plan", "review"],
    verify: ["plan", "review", "build"],
    ship: ["plan", "review", "build", "verify"],
  };
  const allowed = new Set(["review:plan", "build:plan", "verify:plan", "verify:build"]);

  for (const source of stages) {
    for (const target of stages) {
      const active = start(through(fresh(), before[source]), source);
      const transition = () => finish(active, source, { decision: "return", returnTo: target, reasons: ["fix first"] });
      if (allowed.has(`${source}:${target}`)) {
        const returned = transition();
        assert.equal(returned.workflow.stage, target, `${source} -> ${target}`);
        assert.equal(returned.attempts.at(-1)?.status, "returned", `${source} -> ${target}`);
      } else {
        assert.throws(
          transition,
          (error: unknown) => error instanceof CodepatrolError && error.code === "INVALID_TRANSITION",
          `${source} -> ${target}`,
        );
      }
    }
  }
});

test("successful Verify requires command evidence and an exact candidate", () => {
  const verifying = start(through(fresh(), ["plan", "review", "build"]), "verify");
  const active = verifying.attempts.at(-1);
  const result: ManifestResult = { decision: "continue", summary: "verified", handoff: "ship", todo: DONE, artifacts: [] };
  const command = { id: "a1b2c3d4e5f6", type: "command" as const, message: "Tests passed", command: ["npm", "test"], exitCode: 0, at: at() };
  const verifiedCandidate = snapshot();

  assert.throws(
    () => applyTransition(verifying, { type: "finish", stage: "verify", runId: active?.runId ?? runId(0), result, traces: [command], at: at() }),
    (error: unknown) => error instanceof CodepatrolError && error.code === "INVALID_TRANSITION",
  );
  assert.throws(
    () => applyTransition(verifying, { type: "finish", stage: "verify", runId: active?.runId ?? runId(0), result, verifiedCandidate, at: at() }),
    (error: unknown) => error instanceof CodepatrolError && error.code === "INVALID_TRANSITION",
  );
  assert.throws(
    () => applyTransition(verifying, {
      type: "finish",
      stage: "verify",
      runId: active?.runId ?? runId(0),
      result: { ...result, artifacts: [{ path: "README.md", kind: "documentation", blob: "c".repeat(40) }] },
      verifiedCandidate,
      at: at(),
    }),
    (error: unknown) => error instanceof CodepatrolError && error.code === "INVALID_TRANSITION",
  );

  const verified = applyTransition(verifying, {
    type: "finish", stage: "verify", runId: active?.runId ?? runId(0), result, traces: [command], verifiedCandidate, at: at(),
  });
  assert.equal(verified.workflow.stage, "ship");
  assert.deepEqual(verified.attempts.at(-1)?.verifiedCandidate, verifiedCandidate);
});

test("rejects malformed Verify command evidence when loading a manifest", () => {
  const verified = through(fresh(), ["plan", "review", "build", "verify"]);
  const missingCommand = JSON.parse(serializeManifest(verified)) as { attempts: Array<{ traces?: Array<Record<string, unknown>> }> };
  assert.ok(missingCommand.attempts.at(-1)?.traces?.[0]);
  delete missingCommand.attempts.at(-1)?.traces?.[0]?.command;
  assert.throws(
    () => parseWorkManifest(missingCommand),
    (error: unknown) => error instanceof CodepatrolError && error.code === "STATE_CORRUPT",
  );

  const fractionalExit = JSON.parse(serializeManifest(verified)) as { attempts: Array<{ traces?: Array<Record<string, unknown>> }> };
  const trace = fractionalExit.attempts.at(-1)?.traces?.[0];
  assert.ok(trace);
  trace.exitCode = 0.5;
  assert.throws(
    () => parseWorkManifest(fractionalExit),
    (error: unknown) => error instanceof CodepatrolError && error.code === "STATE_CORRUPT",
  );
});

test("refuses every transition once the Work is terminal", () => {
  const terminal = finish(start(through(fresh(), ["plan", "review", "build", "verify"]), "ship"), "ship", { decision: "rollback", authority: "release-owner" });
  assert.throws(() => start(terminal, "plan"), (error: unknown) => error instanceof CodepatrolError && error.code === "INVALID_TRANSITION");
  assert.equal(terminal.completion?.outcome, "rolled-back");
});

test("stageAfter refuses to run past ship", () => {
  assert.equal(stageAfter("plan"), "review");
  assert.equal(stageAfter("verify"), "ship");
  assert.throws(() => stageAfter("ship"), (error: unknown) => error instanceof CodepatrolError && error.code === "INVALID_TRANSITION");
});

test("derives the Change from the lifecycle rather than storing it", () => {
  const planning = start(fresh(), "plan");
  assert.equal(changeState(planning), "draft");

  const reviewed = through(fresh(), ["plan", "review"]);
  assert.equal(changeOf(reviewed).review?.decision, "approved");
  assert.equal(changeState(reviewed), "draft");

  const verified = through(fresh(), ["plan", "review", "build", "verify"]);
  const change = changeOf(verified);
  assert.equal(change.state, "ready");
  assert.equal(change.checks?.decision, "passed");
  assert.equal(change.branch, "refs/heads/codepatrol/work/INIT-0.1-fix-authentication");
  assert.deepEqual(change.verification, snapshot());

  const accepted = finish(start(verified, "ship"), "ship", { decision: "accept", authority: "owner" });
  assert.equal(changeState(accepted), "integrated");

  const rolledBack = finish(start(verified, "ship"), "ship", { decision: "rollback", authority: "owner" });
  assert.equal(changeState(rolledBack), "closed");
});

test("the Change is offered only once verification stands", () => {
  // A failed verification leaves the Change in draft with a recorded verdict.
  const returned = finish(start(through(fresh(), ["plan", "review", "build"]), "verify"), "verify", { decision: "return", returnTo: "build", reasons: ["regression"] });
  assert.equal(changeState(returned), "draft");
  assert.equal(changeOf(returned).checks?.decision, "returned");

  // Re-verifying after the rebuild supersedes it, and only then is it offered.
  const reverified = through(returned, ["build", "verify"]);
  assert.equal(changeState(reverified), "ready");
  assert.equal(changeOf(reverified).checks?.decision, "passed");
  assert.equal(changeOf(reverified).checks?.attempt, 2);
});

test("round-trips through serialization with a stable field order", () => {
  const manifest = through(fresh(), ["plan", "review"], { plan: { artifacts: [{ path: "spec.md", kind: "specification", blob: "b".repeat(40) }] } });
  const serialized = serializeManifest(manifest);

  assert.deepEqual(parseWorkManifest(JSON.parse(serialized) as unknown, IDENTITY.id), manifest);
  // Field order is fixed, so an unchanged manifest produces an unchanged file.
  assert.equal(serializeManifest(parseWorkManifest(JSON.parse(serialized) as unknown)), serialized);
  assert.match(serialized, /^\{\n  "schemaVersion": 1,\n  "type": "codepatrol-work",\n  "work": \{/);
  assert.ok(serialized.endsWith("\n"));
});

test("rejects a manifest whose completion and workflow state disagree", () => {
  const manifest = fresh();
  const raw = JSON.parse(serializeManifest(manifest)) as Record<string, unknown>;
  raw.completion = { outcome: "accepted", authority: "owner", finalizedAt: IDENTITY.createdAt, summary: "done" };

  assert.throws(
    () => parseWorkManifest(raw),
    (error: unknown) => error instanceof CodepatrolError && error.code === "STATE_CORRUPT",
  );
});

test("binds terminal workflow and completion details to the Ship attempt", () => {
  const verified = through(fresh(), ["plan", "review", "build", "verify"]);
  const accepted = finish(start(verified, "ship"), "ship", { decision: "accept", authority: "owner" });
  const raw = JSON.parse(serializeManifest(accepted)) as {
    workflow: { stage: string; attempt: number };
    completion: { finalizedAt: string; summary: string };
  };

  for (const mutate of [
    () => { raw.workflow.stage = "plan"; },
    () => { raw.workflow.attempt = 999; },
    () => { raw.completion.finalizedAt = IDENTITY.createdAt; },
    () => { raw.completion.summary = "forged"; },
  ]) {
    const copy = structuredClone(raw);
    mutate();
    assert.throws(
      () => parseWorkManifest(raw),
      (error: unknown) => error instanceof CodepatrolError && error.code === "STATE_CORRUPT",
    );
    Object.assign(raw, copy);
  }
});

test("rejects unknown fields, a wrong schema version, and a mismatched id", () => {
  const raw = JSON.parse(serializeManifest(fresh())) as Record<string, unknown>;

  assert.throws(() => parseWorkManifest({ ...raw, surprise: true }), (error: unknown) => error instanceof CodepatrolError && error.code === "STATE_CORRUPT");
  assert.throws(() => parseWorkManifest({ ...raw, schemaVersion: 99 }), (error: unknown) => error instanceof CodepatrolError && error.code === "STATE_CORRUPT");
  assert.throws(() => parseWorkManifest(raw, "INIT-0.2-other"), (error: unknown) => error instanceof CodepatrolError && error.code === "STATE_CORRUPT");
});

test("requires issueType and a paired branch baseline", () => {
  const missingIssueType = JSON.parse(serializeManifest(fresh())) as { work: Record<string, unknown> };
  delete missingIssueType.work.issueType;
  assert.throws(
    () => parseWorkManifest(missingIssueType),
    (error: unknown) => error instanceof CodepatrolError && error.code === "STATE_CORRUPT",
  );

  // The baseline fields are optional while no branch exists, but they are
  // recorded together: one without the other is a torn write.
  const withBaseline = {
    ...JSON.parse(serializeManifest(fresh())) as Record<string, unknown>,
    repository: { baseRef: "refs/heads/main", baselineCommit: BASE },
  };
  assert.throws(
    () => parseWorkManifest(withBaseline),
    (error: unknown) => error instanceof CodepatrolError && error.code === "STATE_CORRUPT",
  );
  const paired = {
    ...JSON.parse(serializeManifest(fresh())) as Record<string, unknown>,
    repository: { baseRef: "refs/heads/main", createdFromCommit: BASE, baselineCommit: BASE },
  };
  assert.equal(parseWorkManifest(paired).repository.baselineCommit, BASE);
});

test("a decision that carries the work forward cannot rest on a failed item", () => {
  const planned = start(fresh(), "plan");
  for (const decision of ["continue"] as const) {
    assert.throws(
      () => finish(planned, "plan", { decision, todo: [{ id: "T1", status: "failed" }] }),
      (error: unknown) => error instanceof CodepatrolError
        && error.code === "INVALID_TRANSITION"
        && error.message.includes("cannot carry failed items"),
      decision,
    );
  }

  // Ship may not accept on a failed item either, but may roll back on one.
  const verified = finish(start(finish(start(finish(start(finish(start(fresh(), "plan"), "plan"), "review"), "review"), "build"), "build"), "verify"), "verify");
  const shipping = start(verified, "ship");
  assert.throws(
    () => finish(shipping, "ship", { decision: "accept", authority: "release-owner", todo: [{ id: "T1", status: "failed" }] }),
    (error: unknown) => error instanceof CodepatrolError && error.message.includes("cannot carry failed items"),
  );
  assert.doesNotThrow(
    () => finish(shipping, "ship", { decision: "rollback", authority: "release-owner", todo: [{ id: "T1", status: "failed" }] }),
    "a rollback is exactly what a failed item calls for",
  );
});

test("a skipped item owes a reason, because not applicable is a claim", () => {
  const planned = start(fresh(), "plan");
  assert.throws(
    () => finish(planned, "plan", { todo: [{ id: "T1", status: "skipped" }] }),
    (error: unknown) => error instanceof CodepatrolError && error.message.includes("skipped without a justification"),
  );
  assert.throws(
    () => finish(planned, "plan", { todo: [{ id: "T1", status: "skipped", note: "   " }] }),
    (error: unknown) => error instanceof CodepatrolError && error.message.includes("skipped without a justification"),
  );
  assert.doesNotThrow(() => finish(planned, "plan", { todo: [{ id: "T1", status: "skipped", note: "no migration exists to change" }] }));
});
