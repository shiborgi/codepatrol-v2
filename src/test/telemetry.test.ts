import assert from "node:assert/strict";
import test from "node:test";
import { ChangeIntegration } from "../adapters/integration.js";
import { GitManifestStore } from "../adapters/manifest-store.js";
import { LocalGitPort } from "../adapters/git-port.js";
import { Worktrees, worktreeStoreHooks } from "../adapters/worktree.js";
import { WorkService, type WorkServiceTelemetry } from "../application/work-service.js";
import { SpecService } from "../application/spec-service.js";
import type { TelemetryCollector } from "../application/telemetry.js";
import { CodepatrolError } from "../core/errors.js";
import { INITIATIVE_DOCUMENT_SCHEMA_VERSION, INITIATIVE_DOCUMENT_TYPE, type InitiativeDocument } from "../core/initiative-document.js";
import { type IssueType, type Stage, type TodoItem, type WorkPriority } from "../core/types.js";
import { parseWorkManifest, serializeManifest } from "../core/work-manifest.js";
import type { AttemptTelemetry } from "../core/telemetry.js";
import { parseAttemptTelemetry } from "../core/telemetry.js";
import { parseTelemetryInput } from "../cli/inputs.js";
import { TestClock } from "./support/app.js";
import { createTestRepo, type TestRepo } from "./support/repo.js";

const TODO: TodoItem[] = [{ id: "T1", title: "Do the work" }];
const DONE = [{ id: "T1", status: "completed" as const }];

function serviceFor(repo: TestRepo, telemetry?: WorkServiceTelemetry): WorkService {
  const worktrees = new Worktrees(repo.root);
  const store = new GitManifestStore(repo.root, worktreeStoreHooks(worktrees));
  return new WorkService(store, worktrees, new ChangeIntegration(repo.root, worktrees), new LocalGitPort(repo.root), new TestClock(), repo.root, telemetry);
}

async function createWork(
  repo: TestRepo,
  input: { type: IssueType; title: string; description?: string; priority?: WorkPriority; blockedBy?: string[] },
): Promise<string> {
  const worktrees = new Worktrees(repo.root);
  const store = new GitManifestStore(repo.root, worktreeStoreHooks(worktrees));
  const spec = new SpecService(store, worktrees, new TestClock());
  const inspection = await spec.inspect();
  const initiatives = await store.listInitiatives();
  const declared = initiatives.length > 0;
  const current = initiatives.at(-1);
  const peers = current === undefined ? [] : (await store.list())
    .map((revision) => revision.manifest)
    .filter((manifest) => manifest.completion === null && manifest.work.initiative.id === current.id)
    .map((manifest) => ({
      id: manifest.work.id,
      title: manifest.work.title,
      description: manifest.work.description,
      issueType: manifest.work.issueType,
      priority: manifest.work.priority,
      acceptance: manifest.work.acceptance,
      blockedBy: manifest.graph.blockedBy.map((id) => ({ kind: "id" as const, id })),
    }));
  const document: InitiativeDocument = {
    schemaVersion: INITIATIVE_DOCUMENT_SCHEMA_VERSION,
    type: INITIATIVE_DOCUMENT_TYPE,
    documentId: `test-create-${inspection.digest.slice(0, 12)}`,
    summary: "Create lifecycle fixture",
    observedState: "test fixture",
    digest: inspection.digest,
    createdAt: "2026-07-29T10:00:00.000Z",
    works: [...peers, {
      key: "work",
      title: input.title,
      description: input.description ?? "Lifecycle fixture",
      issueType: input.type,
      priority: input.priority ?? "p1",
      acceptance: ["The lifecycle fixture passes"],
      blockedBy: (input.blockedBy ?? []).map((id) => ({ kind: "id" as const, id })),
      requestedBy: "test",
    }],
    cancel: [],
    supersede: [],
    followUp: [],
    ...(declared ? {} : { initiative: { title: "Lifecycle fixture", intent: "i", motivation: "m", ordering: "o" } }),
  };
  const applied = await spec.apply(document);
  return applied.createdWorkIds?.[0] as string;
}

async function runStage(service: WorkService, stage: Stage, workId: string, result?: Partial<import("../application/work-service.js").ResultInput>): Promise<void> {
  const started = await service.start(stage, workId, "test-harness", "test-model", TODO);
  const decision = (result as Record<string, unknown>)?.decision as string ?? (stage === "ship" ? "accept" : "continue");
  if (stage === "verify" && decision === "continue") {
    await service.trace(stage, workId, started.runId, { type: "command", message: "Tests passed", command: ["npm", "test"], exitCode: 0 });
  }
  await service.complete(stage, workId, started.runId, {
    decision: decision as "continue" | "return" | "accept" | "rollback",
    summary: `${stage} done`,
    handoff: "next",
    todo: DONE,
    artifacts: [],
    ...(stage === "ship" ? { authority: "release-owner" } : {}),
    ...result,
  });
}

async function through(service: WorkService, workId: string, stages: readonly Stage[], final: Partial<import("../application/work-service.js").ResultInput> = {}): Promise<void> {
  for (const stage of stages) await runStage(service, stage, workId, stage === "ship" ? final : {});
}

function fixedTelemetry(overrides: Partial<AttemptTelemetry> = {}): TelemetryCollector {
  return {
    async collect() {
      return {
        skills: overrides.skills ?? { count: 1, bytes: 1000 },
        context: overrides.context ?? { sections: 5, bytes: 2000 },
        tools: overrides.tools ?? { count: 12, failures: 0, inputBytes: 500, outputBytes: 300 },
        model: overrides.model ?? { inputTokens: 1000, outputTokens: 500 },
      };
    },
  };
}

test("a completed stage attempt carries bounded telemetry", async () => {
  const repo = await createTestRepo();
  try {
    const service = serviceFor(repo, {
      collector: fixedTelemetry(),
      skillManifests: [],
      hostCapabilities: ["cli"],
    });
    const workId = await createWork(repo, { type: "Task", title: "Telemetry across stages" });

    // Plan records telemetry on complete.
    const planStarted = await service.start("plan", workId, "h", "m", TODO);
    await service.complete("plan", workId, planStarted.runId, { decision: "continue", summary: "planned", handoff: "review", todo: DONE, artifacts: [] });
    const view = await service.show(workId);
    assert.ok(view.attempts[0]?.telemetry, "plan attempt carries telemetry");
    assert.deepEqual(view.attempts[0]?.telemetry?.skills, { count: 1, bytes: 1000 });
    assert.deepEqual(view.attempts[0]?.telemetry?.context, { sections: 5, bytes: 2000 });
    assert.deepEqual(view.attempts[0]?.telemetry?.tools, { count: 12, failures: 0, inputBytes: 500, outputBytes: 300 });
    assert.deepEqual(view.attempts[0]?.telemetry?.model, { inputTokens: 1000, outputTokens: 500 });

    // Review records its own telemetry without touching the plan attempt's.
    const reviewStarted = await service.start("review", workId, "h", "m", TODO);
    await service.complete("review", workId, reviewStarted.runId, { decision: "continue", summary: "s", handoff: "h", todo: DONE, artifacts: [] });
    const afterReview = await service.show(workId);
    assert.ok(afterReview.attempts[1]?.telemetry, "review attempt carries telemetry");
    assert.deepEqual(afterReview.attempts[0]?.telemetry, view.attempts[0]?.telemetry, "earlier attempt's telemetry is untouched by a later one");
  } finally {
    await repo.cleanup();
  }
});

test("a manifest without the telemetry field still parses under schemaVersion 1", async () => {
  // When no collector is injected, complete still records the transition — the
  // attempt just has no telemetry field, and the parser must accept that.
  const repo = await createTestRepo();
  try {
    const service = serviceFor(repo);
    const workId = await createWork(repo, { type: "Task", title: "No telemetry" });
    const started = await service.start("plan", workId, "h", "m", TODO);
    await service.complete("plan", workId, started.runId, { decision: "continue", summary: "s", handoff: "h", todo: DONE, artifacts: [] });

    const worktrees = new Worktrees(repo.root);
    const store = new GitManifestStore(repo.root, worktreeStoreHooks(worktrees));
    const revision = await store.read(workId);
    const serialized = serializeManifest(revision.manifest);
    const parsed = parseWorkManifest(JSON.parse(serialized), workId);
    assert.equal(parsed.attempts[0]?.telemetry, undefined, "an attempt without a collector has no telemetry field");
  } finally {
    await repo.cleanup();
  }
});

test("absent model and tools recorded as explicitly unavailable", async () => {
  const repo = await createTestRepo();
  try {
    const collector = fixedTelemetry({ tools: "unavailable" as const, model: "unavailable" as const });
    const service = serviceFor(repo, { collector, skillManifests: [], hostCapabilities: ["cli"] });
    const workId = await createWork(repo, { type: "Task", title: "Unavailable telemetry" });
    const started = await service.start("plan", workId, "h", "m", TODO);
    await service.complete("plan", workId, started.runId, { decision: "continue", summary: "s", handoff: "h", todo: DONE, artifacts: [] });

    const view = await service.show(workId);
    assert.equal(view.attempts[0]?.telemetry?.tools, "unavailable");
    assert.equal(view.attempts[0]?.telemetry?.model, "unavailable");
  } finally {
    await repo.cleanup();
  }
});

test("an injected telemetry failure leaves the transition, the result, and Ship unaffected", async () => {
  const repo = await createTestRepo({ defaultBranch: "trunk" });
  try {
    let calls = 0;
    const throwingCollector: TelemetryCollector = {
      async collect() {
        calls += 1;
        throw new Error("simulated collector failure");
      },
    };
    const service = serviceFor(repo, { collector: throwingCollector, skillManifests: [], hostCapabilities: ["cli"] });
    const workId = await createWork(repo, { type: "Feature", title: "Throwing collector" });
    const started = await service.start("plan", workId, "h", "m", TODO);
    await service.complete("plan", workId, started.runId, { decision: "continue", summary: "planned", handoff: "review", todo: DONE, artifacts: [] });

    // The transition succeeded, the result is recorded, but telemetry is absent.
    const view = await service.show(workId);
    assert.equal(view.stage, "review", "the lifecycle advanced despite the collector failure");
    assert.equal(view.attempts[0]?.result?.decision, "continue", "the result was recorded");
    assert.equal(view.attempts[0]?.telemetry, undefined, "telemetry is absent when the collector throws");
    assert.equal(calls, 1);
  } finally {
    await repo.cleanup();
  }
});

test("telemetry survives into the manifest of a terminal Work", async () => {
  const repo = await createTestRepo({ defaultBranch: "trunk" });
  try {
    const service = serviceFor(repo, {
      collector: fixedTelemetry(),
      skillManifests: [],
      hostCapabilities: ["cli"],
    });
    const workId = await createWork(repo, { type: "Feature", title: "Terminal telemetry" });
    await through(service, workId, ["plan", "review"]);

    const built = await service.start("build", workId, "h", "m", TODO);
    await service.complete("build", workId, built.runId, { decision: "continue", summary: "s", handoff: "h", todo: DONE, artifacts: [] });
    await through(service, workId, ["verify"]);
    await runStage(service, "ship", workId);

    const view = await service.show(workId);
    assert.equal(view.state, "terminal");
    assert.equal(view.outcome, "accepted");
    assert.equal(view.attempts.filter((attempt) => attempt.telemetry !== undefined).length, 5, "all five stage attempts carry telemetry");
  } finally {
    await repo.cleanup();
  }
});

test("parseAttemptTelemetry rejects unknown fields and non-integer leaves", () => {
  // Valid shape parses.
  const valid = { skills: { count: 1, bytes: 2 }, context: { sections: 3, bytes: 4 }, tools: { count: 5, failures: 0, inputBytes: 6, outputBytes: 7 }, model: { inputTokens: 8, outputTokens: 9 } };
  const parsed = parseAttemptTelemetry(valid, "label");
  assert.deepEqual(parsed, valid);

  // Unknown field at the top level.
  assert.throws(
    () => parseAttemptTelemetry({ ...valid, extra: true }, "label"),
    (error: unknown) => error instanceof CodepatrolError && error.code === "STATE_CORRUPT",
  );

  // Non-integer leaf.
  assert.throws(
    () => parseAttemptTelemetry({ ...valid, skills: { count: 1, bytes: "not-an-int" } }, "label"),
    (error: unknown) => error instanceof CodepatrolError && error.code === "STATE_CORRUPT",
  );

  // Negative leaf.
  assert.throws(
    () => parseAttemptTelemetry({ ...valid, context: { sections: -1, bytes: 4 } }, "label"),
    (error: unknown) => error instanceof CodepatrolError && error.code === "STATE_CORRUPT",
  );

  // Non-number leaf.
  assert.throws(
    () => parseAttemptTelemetry({ ...valid, model: { inputTokens: 1.5, outputTokens: 9 } }, "label"),
    (error: unknown) => error instanceof CodepatrolError && error.code === "STATE_CORRUPT",
  );
});

test("parseAttemptTelemetry refuses content-carrying fields: prompt, response, reasoning, raw output, env, credential", () => {
  const base = { skills: { count: 1, bytes: 2 }, context: { sections: 3, bytes: 4 }, tools: { count: 5, failures: 0, inputBytes: 6, outputBytes: 7 }, model: { inputTokens: 8, outputTokens: 9 } };
  const forbidden = ["prompt", "response", "reasoning", "rawOutput", "raw_output", "output", "env", "environment", "credential", "secret", "excerpt"];
  for (const field of forbidden) {
    assert.throws(
      () => parseAttemptTelemetry({ ...base, [field]: "sensitive content" }, `label.${field}`),
      (error: unknown) => error instanceof CodepatrolError && error.code === "STATE_CORRUPT",
      `${field} must be refused by the parser`,
    );
  }
});

test("parseTelemetryInput accepts harness-reported tools and model, rejects unknown fields and bad shapes", () => {
  // Full report.
  const report = parseTelemetryInput({ tools: { count: 3, failures: 1, inputBytes: 400, outputBytes: 200 }, model: { inputTokens: 100, outputTokens: 50 } });
  assert.deepEqual(report, { tools: { count: 3, failures: 1, inputBytes: 400, outputBytes: 200 }, model: { inputTokens: 100, outputTokens: 50 } });

  // Tools only.
  assert.deepEqual(parseTelemetryInput({ tools: { count: 0, failures: 0, inputBytes: 0, outputBytes: 0 } }), { tools: { count: 0, failures: 0, inputBytes: 0, outputBytes: 0 } });

  // Model only.
  assert.deepEqual(parseTelemetryInput({ model: { inputTokens: 1, outputTokens: 2 } }), { model: { inputTokens: 1, outputTokens: 2 } });

  // Empty object.
  assert.deepEqual(parseTelemetryInput({}), {});

  // Unknown top-level field.
  assert.throws(
    () => parseTelemetryInput({ prompt: "hello" }),
    (error: unknown) => error instanceof CodepatrolError && error.code === "INVALID_INPUT",
  );

  // Unknown field inside tools.
  assert.throws(
    () => parseTelemetryInput({ tools: { count: 1, failures: 0, inputBytes: 1, outputBytes: 1, extra: true } }),
    (error: unknown) => error instanceof CodepatrolError && error.code === "INVALID_INPUT",
  );

  // Non-integer tool fields.
  assert.throws(
    () => parseTelemetryInput({ tools: { count: 1, failures: 0, inputBytes: 1, outputBytes: "big" } }),
    (error: unknown) => error instanceof CodepatrolError && error.code === "INVALID_INPUT",
  );

  // Array input.
  assert.throws(
    () => parseTelemetryInput(["bad"]),
    (error: unknown) => error instanceof CodepatrolError && error.code === "INVALID_INPUT",
  );
});

test("telemetry serializer and parser round-trip deterministically", async () => {
  const repo = await createTestRepo();
  try {
    const service = serviceFor(repo, {
      collector: fixedTelemetry(),
      skillManifests: [],
      hostCapabilities: ["cli"],
    });
    const workId = await createWork(repo, { type: "Task", title: "Round-trip" });
    const started = await service.start("plan", workId, "h", "m", TODO);
    await service.complete("plan", workId, started.runId, { decision: "continue", summary: "s", handoff: "h", todo: DONE, artifacts: [] });

    const worktrees = new Worktrees(repo.root);
    const store = new GitManifestStore(repo.root, worktreeStoreHooks(worktrees));
    const revision = await store.read(workId);
    const serialized = serializeManifest(revision.manifest);
    const parsed = parseWorkManifest(JSON.parse(serialized), workId);
    assert.ok(parsed.attempts[0]?.telemetry);
    assert.deepEqual(parsed.attempts[0]?.telemetry?.skills, { count: 1, bytes: 1000 });

    // Double round-trip.
    const rese = serializeManifest(parsed);
    const reparsed = parseWorkManifest(JSON.parse(rese), workId);
    assert.deepEqual(reparsed.attempts[0]?.telemetry, parsed.attempts[0]?.telemetry);
  } finally {
    await repo.cleanup();
  }
});
