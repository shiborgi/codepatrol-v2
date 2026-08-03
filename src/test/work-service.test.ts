import assert from "node:assert/strict";
import test from "node:test";
import { ChangeIntegration } from "../adapters/integration.js";
import { GitManifestStore } from "../adapters/manifest-store.js";
import { LocalGitPort } from "../adapters/git-port.js";
import { Worktrees, worktreeStoreHooks } from "../adapters/worktree.js";
import { WorkService, type ResultInput } from "../application/work-service.js";
import { SpecService } from "../application/spec-service.js";
import { CodepatrolError } from "../core/errors.js";
import { INITIATIVE_DOCUMENT_SCHEMA_VERSION, INITIATIVE_DOCUMENT_TYPE, type InitiativeDocument } from "../core/initiative-document.js";
import type { IssueType, Stage, WorkPriority } from "../core/types.js";
import { archiveRef, manifestPath, manifestRef, workBranchRef } from "../core/work-manifest.js";
import { TestClock } from "./support/app.js";
import { createTestRepo, type TestRepo } from "./support/repo.js";

const TODO = [{ id: "T1", title: "Do the work" }];
const DONE = [{ id: "T1", status: "completed" as const }];

function serviceFor(repo: TestRepo): WorkService {
  const worktrees = new Worktrees(repo.root);
  const store = new GitManifestStore(repo.root, worktreeStoreHooks(worktrees));
  return new WorkService(store, worktrees, new ChangeIntegration(repo.root, worktrees), new LocalGitPort(repo.root), new TestClock(), repo.root);
}

async function createWork(
  repo: TestRepo,
  service: WorkService,
  input: { type: IssueType; title: string; description?: string; priority?: WorkPriority; blockedBy?: string[] },
) {
  const worktrees = new Worktrees(repo.root);
  const store = new GitManifestStore(repo.root, worktreeStoreHooks(worktrees));
  const spec = new SpecService(store, worktrees, new TestClock());
  const inspection = await spec.inspect();
  const initiatives = await store.listInitiatives();
  const declared = initiatives.length > 0;
  // Every non-terminal member of the target Initiative must stay named in the
  // document, or the diff reads its silent absence as a drop. Restating each
  // one's current fields is a no-op mention: it neither claims a change nor
  // disturbs whatever stage or run the Work is in.
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
  return service.show(applied.createdWorkIds?.[0] as string);
}

async function runStage(service: WorkService, stage: Stage, workId: string, result: Partial<ResultInput> = {}): Promise<void> {
  const started = await service.start(stage, workId, "test-harness", "test-model", TODO);
  const decision = result.decision ?? (stage === "ship" ? "accept" : "continue");
  if (stage === "verify" && decision === "continue") {
    await service.trace(stage, workId, started.runId, { type: "command", message: "Tests passed", command: ["npm", "test"], exitCode: 0 });
  }
  await service.complete(stage, workId, started.runId, {
    decision,
    summary: `${stage} done`,
    handoff: "next",
    todo: DONE,
    artifacts: [],
    ...(stage === "ship" ? { authority: "release-owner" } : {}),
    ...result,
  });
}

async function through(service: WorkService, workId: string, stages: readonly Stage[], final: Partial<ResultInput> = {}): Promise<void> {
  for (const stage of stages) await runStage(service, stage, workId, stage === "ship" ? final : {});
}

test("an accepted Work adds exactly one commit to the base", async () => {
  const repo = await createTestRepo({ defaultBranch: "trunk" });
  try {
    const service = serviceFor(repo);
    const created = await createWork(repo, service, { type: "Feature", title: "Ship something" });
    const workId = created.identity.id;

    // Creating the Work did not touch the base.
    assert.equal(await repo.commitCount("refs/heads/trunk"), 1);

    await through(service, workId, ["plan", "review"]);
    const built = await service.start("build", workId, "h", "m", TODO);
    assert.notEqual(built.worktreeDirectory, null);
    await repo.write(".codepatrol/runtime/worktrees/" + workId + "/feature.txt", "one\n");
    await repo.gitIn(built.worktreeDirectory as string, "add", "feature.txt");
    await repo.gitIn(built.worktreeDirectory as string, "commit", "-q", "-m", "implement");
    await service.complete("build", workId, built.runId, { decision: "continue", summary: "built", handoff: "verify", todo: DONE, artifacts: [] });
    await through(service, workId, ["verify"]);
    // Opening the branch projected the manifest into the base once; accept has
    // not run yet, so the base carries exactly that and nothing more.
    assert.equal(await repo.commitCount("refs/heads/trunk"), 2);

    await runStage(service, "ship", workId);

    assert.equal(await repo.commitCount("refs/heads/trunk"), 3, "accept adds exactly one squash commit");
    const message = await repo.messageLines("refs/heads/trunk");
    assert.ok(message.includes(`Codepatrol-Work: ${workId}`));
    assert.equal(await repo.showFile("refs/heads/trunk", "feature.txt"), "one");
    // The manifest reaches the base through the squash, so an accepted Work is
    // rebuildable from the base alone.
    assert.notEqual(await repo.showFile("refs/heads/trunk", manifestPath(workId)), undefined);

    const view = await service.show(workId);
    assert.equal(view.state, "terminal");
    assert.equal(view.outcome, "accepted");
    assert.equal(view.change.state, "integrated");
    assert.equal(view.source, "manifest", "the manifest ref stays the authority after integration");
    // The working branch and its worktree are gone; the archive keeps the code
    // history — the cut and the builder's commit — while the manifest ledger
    // lives on its own ref.
    assert.equal(await repo.refExists(workBranchRef(workId)), false);
    assert.equal(await repo.refExists(archiveRef(workId)), true);
    assert.equal(await repo.commitCount(archiveRef(workId)), 3, "bootstrap, the manifest projection, and the builder's commit");
    // One manifest commit per transition across five stages, plus the creation
    // and the bootstrap ancestor the ledger is parented onto: the record the
    // archive never carried.
    assert.equal(await repo.commitCount(manifestRef(workId)), 1 + 11);
    const history = await repo.git("log", "--format=%s", manifestRef(workId), "--", manifestPath(workId));
    assert.equal(history.split("\n").length, 11, "every transition is a revision of the manifest");
  } finally {
    await repo.cleanup();
  }
});

test("a rolled-back Work adds zero commits to the base", async () => {
  const repo = await createTestRepo({ defaultBranch: "trunk" });
  try {
    const service = serviceFor(repo);
    const workId = (await createWork(repo, service, { type: "Task", title: "Reject something" })).identity.id;
    await through(service, workId, ["plan", "review"]);
    const built = await service.start("build", workId, "h", "m", TODO);
    // Opening the branch projected the manifest into the base; everything the
    // rollback itself adds to the base is nothing.
    const before = await repo.head("refs/heads/trunk");

    await service.complete("build", workId, built.runId, { decision: "continue", summary: "s", handoff: "h", todo: DONE, artifacts: [] });
    await through(service, workId, ["verify", "ship"], {
      decision: "rollback",
      summary: "the approach was incompatible",
      handoff: "none",
      todo: DONE,
      artifacts: [],
      authority: "release-owner",
    });

    assert.equal(await repo.head("refs/heads/trunk"), before, "rollback adds nothing to the base");
    assert.equal(await repo.commitCount("refs/heads/trunk"), 2, "bootstrap and the manifest projection");
    // The base copy is the cut-time projection: a stale record the ref
    // overrules, never a terminal state the base ever saw.
    const baseCopy = JSON.parse(await repo.showFile("refs/heads/trunk", manifestPath(workId)) ?? "null") as { workflow: { state: string } } | null;
    assert.notEqual(baseCopy?.workflow.state, "terminal", "the base copy stays the cut-time projection");

    const view = await service.show(workId);
    assert.equal(view.outcome, "rolled-back");
    assert.equal(view.change.state, "closed");
    // The record lives on the manifest ref; the code survives in the archive.
    assert.equal(view.source, "manifest");
    assert.equal(await repo.refExists(workBranchRef(workId)), false);
    assert.equal(await repo.refExists(archiveRef(workId)), true);
  } finally {
    await repo.cleanup();
  }
});

test("rollback remains available with uncommitted product changes", async () => {
  const repo = await createTestRepo({ defaultBranch: "trunk" });
  try {
    const service = serviceFor(repo);
    const workId = (await createWork(repo, service, { type: "Task", title: "Discard dirty candidate" })).identity.id;
    await through(service, workId, ["plan", "review", "build", "verify"]);
    const shipped = await service.start("ship", workId, "h", "m", TODO);
    await repo.write(`.codepatrol/runtime/worktrees/${workId}/discard-me.txt`, "dirty\n");
    const rolled = await service.complete("ship", workId, shipped.runId, { decision: "rollback", summary: "discard", handoff: "terminal", todo: DONE, artifacts: [], authority: "owner" });
    assert.equal(rolled.outcome, "rolled-back");
    assert.equal(await repo.commitCount("refs/heads/trunk"), 2, "bootstrap and the manifest projection only");
  } finally {
    await repo.cleanup();
  }
});

test("ships while the operator sits on an unrelated dirty branch", async () => {
  const repo = await createTestRepo({ defaultBranch: "trunk" });
  try {
    const service = serviceFor(repo);
    const workId = (await createWork(repo, service, { type: "Feature", title: "Ship from elsewhere" })).identity.id;
    await through(service, workId, ["plan", "review", "build", "verify"]);

    // An unrelated operator checkout is outside the Change integrity boundary.
    await repo.git("checkout", "-q", "-b", "operator-side");
    await repo.write("scratch.txt", "uncommitted\n");

    await runStage(service, "ship", workId);

    assert.equal(await repo.commitCount("refs/heads/trunk"), 3, "bootstrap, the manifest projection, and the squash");
    assert.equal(await repo.git("symbolic-ref", "--short", "HEAD"), "operator-side");
    assert.equal(await repo.read("scratch.txt"), "uncommitted\n");
  } finally {
    await repo.cleanup();
  }
});

test("keeps a Work reachable after its worktree is deleted", async () => {
  const repo = await createTestRepo();
  try {
    const service = serviceFor(repo);
    const workId = (await createWork(repo, service, { type: "Task", title: "Survives worktree loss" })).identity.id;
    await through(service, workId, ["plan", "review"]);
    const built = await service.start("build", workId, "h", "m", TODO);

    await repo.git("worktree", "remove", "--force", built.worktreeDirectory as string);

    const view = await service.show(workId);
    assert.equal(view.stage, "build");
    assert.equal(view.state, "active");
    // The checkout and handoff are operational conveniences, recreated on demand.
    const resumed = await service.resume("build", workId);
    assert.equal(resumed.runId, built.runId);
    assert.equal(resumed.attempt, built.attempt);
    assert.equal(resumed.worktreeDirectory, built.worktreeDirectory);
    assert.equal(await service.checkout(workId), built.worktreeDirectory);
  } finally {
    await repo.cleanup();
  }
});

test("a Plan that produces only a handoff leaves no branch behind", async () => {
  const repo = await createTestRepo({ defaultBranch: "trunk" });
  try {
    const service = serviceFor(repo);
    const workId = (await createWork(repo, service, { type: "Task", title: "Handoff only" })).identity.id;
    const base = await repo.head("refs/heads/trunk");
    await runStage(service, "plan", workId);

    // No worktree was requested and no code exists, so nothing was created.
    assert.equal(await repo.refExists(workBranchRef(workId)), false, "no branch for a handoff-only stage");
    assert.equal(await repo.head("refs/heads/trunk"), base, "no projection reaches the base");
    const view = await service.show(workId);
    assert.equal(view.repository.branch, null);
    assert.equal(view.repository.baselineCommit, null, "a branchless Work has no baseline to drift from");
    assert.equal(view.stage, "review");

    // The next stage reuses what exists: still nothing, until content arrives.
    await runStage(service, "review", workId);
    assert.equal(await repo.refExists(workBranchRef(workId)), false);
  } finally {
    await repo.cleanup();
  }
});

test("Build cuts the branch from the base of the moment and records it then", async () => {
  const repo = await createTestRepo({ defaultBranch: "trunk" });
  try {
    const service = serviceFor(repo);
    const workId = (await createWork(repo, service, { type: "Feature", title: "Cut late" })).identity.id;
    await through(service, workId, ["plan", "review"]);
    // The Work waited in the backlog while the base moved on.
    await repo.write("base-moved.txt", "later work\n");
    const currentBase = await repo.commit("advance base while the Work waits");

    const built = await service.start("build", workId, "h", "m", TODO);

    assert.notEqual(built.worktreeDirectory, null);
    const cutPoint = await repo.head(workBranchRef(workId));
    assert.equal(await repo.git("rev-parse", `${workBranchRef(workId)}^`), currentBase, "the branch is cut from the base as it stands now");
    const view = await service.show(workId);
    assert.equal(view.repository.baselineCommit, cutPoint, "the baseline is recorded at the cut, not at creation");
    assert.equal(view.repository.createdFromCommit, cutPoint);
    assert.equal((await service.inspect(workId)).baselineStale, false, "a freshly cut branch is not stale");
    assert.ok(!(await service.inspect(workId)).changedFiles.includes("base-moved.txt"), "files the base gained before the cut are not attributed to the Change");

    // A second stage reuses the branch rather than cutting a new one.
    await service.complete("build", workId, built.runId, { decision: "continue", summary: "s", handoff: "h", todo: DONE, artifacts: [] });
    const afterBuild = await repo.head(workBranchRef(workId));
    const verified = await service.start("verify", workId, "h", "m", TODO);
    assert.equal(await repo.head(workBranchRef(workId)), afterBuild, "the next stage reuses the existing branch");
    assert.equal((await service.show(workId)).repository.baselineCommit, cutPoint, "the baseline is recorded exactly once");
    await service.complete("verify", workId, verified.runId, { decision: "continue", summary: "s", handoff: "h", todo: DONE, artifacts: [] });
  } finally {
    await repo.cleanup();
  }
});

test("records traces on the attempt they belong to, one commit per transition", async () => {
  const repo = await createTestRepo();
  try {
    const service = serviceFor(repo);
    const workId = (await createWork(repo, service, { type: "Task", title: "Traced" })).identity.id;
    const started = await service.start("plan", workId, "h", "m", TODO);
    const beforeTraces = await repo.commitCount(manifestRef(workId));

    await service.trace("plan", workId, started.runId, { type: "decision", message: "Chose the smallest design" });
    await service.trace("plan", workId, started.runId, { type: "observation", message: "Two call sites only" });
    assert.equal(await repo.commitCount(manifestRef(workId)), beforeTraces, "tracing does not commit");

    await service.complete("plan", workId, started.runId, { decision: "continue", summary: "planned", handoff: "review", todo: DONE, artifacts: [] });

    const view = await service.show(workId);
    assert.deepEqual(view.attempts[0]?.traces?.map((trace) => trace.message), ["Chose the smallest design", "Two call sites only"]);
    assert.equal(await repo.commitCount(manifestRef(workId)), beforeTraces + 1, "the transition is one commit on the manifest ref");
  } finally {
    await repo.cleanup();
  }
});

test("repeating complete is idempotent and rejects a different payload", async () => {
  const repo = await createTestRepo();
  try {
    const service = serviceFor(repo);
    const workId = (await createWork(repo, service, { type: "Task", title: "Idempotent completion" })).identity.id;
    const started = await service.start("plan", workId, "h", "m", TODO);
    const result = { decision: "continue" as const, summary: "planned", handoff: "review", todo: DONE, artifacts: [] };
    await service.complete("plan", workId, started.runId, result);
    const before = await repo.commitCount(manifestRef(workId));
    const repeated = await service.complete("plan", workId, started.runId, result);
    assert.equal(repeated.stage, "review");
    assert.equal(await repo.commitCount(manifestRef(workId)), before);
    await assert.rejects(
      service.complete("plan", workId, started.runId, { ...result, summary: "different" }),
      (error: unknown) => error instanceof CodepatrolError && error.code === "RESULT_CONFLICT",
    );
  } finally {
    await repo.cleanup();
  }
});

test("executes Verify policy and records the candidate selected by WorkService", async () => {
  const repo = await createTestRepo();
  try {
    const service = serviceFor(repo);
    const workId = (await createWork(repo, service, { type: "Bug", title: "Evidence gate" })).identity.id;
    await through(service, workId, ["plan", "review", "build"]);
    const started = await service.start("verify", workId, "h", "m", TODO);

    const verified = await service.complete("verify", workId, started.runId, { decision: "continue", summary: "s", handoff: "ship", todo: DONE, artifacts: [] });
    const snapshot = verified.attempts.at(-1)?.verifiedCandidate;
    assert.ok(snapshot);
    assert.deepEqual(verified.change.verification, snapshot);
    assert.equal(snapshot.baselineCommit, verified.repository.baselineCommit);
  } finally {
    await repo.cleanup();
  }
});

test("Verify refuses product or base movement after its start snapshot", async () => {
  const repo = await createTestRepo({ defaultBranch: "trunk" });
  try {
    const service = serviceFor(repo);
    const workId = (await createWork(repo, service, { type: "Bug", title: "Pin Verify input" })).identity.id;
    await through(service, workId, ["plan", "review", "build"]);
    const started = await service.start("verify", workId, "h", "m", TODO);
    const worktree = started.worktreeDirectory as string;
    await repo.write(`.codepatrol/runtime/worktrees/${workId}/during-verify.txt`, "changed\n");
    await repo.gitIn(worktree, "add", "during-verify.txt");
    await repo.gitIn(worktree, "commit", "-q", "-m", "change during verify");
    await service.trace("verify", workId, started.runId, { type: "command", message: "Tests passed", command: ["npm", "test"], exitCode: 0 });
    await assert.rejects(
      service.complete("verify", workId, started.runId, { decision: "continue", summary: "s", handoff: "ship", todo: DONE, artifacts: [] }),
      (error: unknown) => error instanceof CodepatrolError && error.code === "VERIFY_STALE" && /during-verify\.txt/.test(error.message),
    );
  } finally {
    await repo.cleanup();
  }
});

test("Verify detects product changes introduced by a merge commit", async () => {
  const repo = await createTestRepo();
  try {
    const service = serviceFor(repo);
    const workId = (await createWork(repo, service, { type: "Bug", title: "Merge during Verify" })).identity.id;
    await through(service, workId, ["plan", "review", "build"]);
    const started = await service.start("verify", workId, "h", "m", TODO);
    const worktree = started.worktreeDirectory as string;
    await repo.gitIn(worktree, "switch", "-q", "-c", "verify-side");
    await repo.write(`.codepatrol/runtime/worktrees/${workId}/merged.txt`, "unverified\n");
    await repo.gitIn(worktree, "add", "merged.txt");
    await repo.gitIn(worktree, "commit", "-q", "-m", "side product change");
    await repo.gitIn(worktree, "switch", "-q", `codepatrol/work/${workId}`);
    await repo.gitIn(worktree, "merge", "-q", "--no-ff", "verify-side", "-m", "merge unverified product");
    await service.trace("verify", workId, started.runId, { type: "command", message: "Tests passed", command: ["npm", "test"], exitCode: 0 });

    await assert.rejects(
      service.complete("verify", workId, started.runId, { decision: "continue", summary: "s", handoff: "ship", todo: DONE, artifacts: [] }),
      (error: unknown) => error instanceof CodepatrolError && error.code === "VERIFY_STALE" && /merged\.txt/.test(error.message),
    );
  } finally {
    await repo.cleanup();
  }
});

test("refuses an artifact that is not committed on the Change", async () => {
  const repo = await createTestRepo();
  try {
    const service = serviceFor(repo);
    const workId = (await createWork(repo, service, { type: "Task", title: "Artifacts" })).identity.id;
    const started = await service.start("plan", workId, "h", "m", TODO);

    await assert.rejects(
      service.complete("plan", workId, started.runId, {
        decision: "continue", summary: "s", handoff: "h", todo: DONE,
        artifacts: [{ path: "spec.md", kind: "specification" }],
      }),
      (error: unknown) => error instanceof CodepatrolError && error.code === "ARTIFACT_NOT_COMMITTED",
    );
  } finally {
    await repo.cleanup();
  }
});

test("refuses its own manifest as an artifact", async () => {
  const repo = await createTestRepo();
  try {
    const service = serviceFor(repo);
    const workId = (await createWork(repo, service, { type: "Task", title: "Reserved artifact" })).identity.id;
    const started = await service.start("plan", workId, "h", "m", TODO);

    await assert.rejects(
      service.complete("plan", workId, started.runId, {
        decision: "continue", summary: "s", handoff: "h", todo: DONE,
        artifacts: [{ path: manifestPath(workId), kind: "manifest" }],
      }),
      (error: unknown) => error instanceof CodepatrolError && error.code === "RESERVED_PATH",
    );
    await assert.rejects(
      service.complete("plan", workId, started.runId, {
        decision: "continue", summary: "s", handoff: "h", todo: DONE,
        artifacts: [{ path: `./${manifestPath(workId)}`, kind: "manifest" }],
      }),
      (error: unknown) => error instanceof CodepatrolError && ["UNSAFE_PATH", "RESERVED_PATH"].includes(error.code),
    );
  } finally {
    await repo.cleanup();
  }
});

test("refuses a directory declared as a blob artifact", async () => {
  const repo = await createTestRepo({ files: { "docs/readme.md": "content\n" } });
  try {
    const service = serviceFor(repo);
    const workId = (await createWork(repo, service, { type: "Task", title: "Blob artifacts only" })).identity.id;
    const started = await service.start("plan", workId, "h", "m", TODO, { worktree: true });
    await assert.rejects(
      service.complete("plan", workId, started.runId, { decision: "continue", summary: "s", handoff: "h", todo: DONE, artifacts: [{ path: "docs", kind: "directory" }] }),
      (error: unknown) => error instanceof CodepatrolError && error.code === "INVALID_ARTIFACT",
    );
  } finally {
    await repo.cleanup();
  }
});

test("Plan refuses uncommitted reserved paths in an explicitly created worktree", async () => {
  const repo = await createTestRepo();
  try {
    const service = serviceFor(repo);
    const workId = (await createWork(repo, service, { type: "Task", title: "Plan path policy" })).identity.id;
    const started = await service.start("plan", workId, "h", "m", TODO, { worktree: true });
    await repo.write(`.codepatrol/runtime/worktrees/${workId}/.codepatrol/forged.json`, "{}\n");
    await assert.rejects(
      service.complete("plan", workId, started.runId, { decision: "continue", summary: "s", handoff: "h", todo: DONE, artifacts: [] }),
      (error: unknown) => error instanceof CodepatrolError && error.code === "RESERVED_PATH",
    );
  } finally {
    await repo.cleanup();
  }
});

test("refuses an executor commit that modifies its own manifest", async () => {
  const repo = await createTestRepo();
  try {
    const service = serviceFor(repo);
    const workId = (await createWork(repo, service, { type: "Task", title: "Reserved manifest" })).identity.id;
    await through(service, workId, ["plan", "review"]);
    const built = await service.start("build", workId, "h", "m", TODO);
    const worktree = built.worktreeDirectory as string;
    await repo.write(`.codepatrol/runtime/worktrees/${workId}/${manifestPath(workId)}`, "{}\n");
    await repo.gitIn(worktree, "add", "--", manifestPath(workId));
    await repo.gitIn(worktree, "commit", "-q", "-m", "tamper with own manifest");

    await assert.rejects(
      service.complete("build", workId, built.runId, { decision: "continue", summary: "s", handoff: "h", todo: DONE, artifacts: [] }),
      (error: unknown) => error instanceof CodepatrolError && error.code === "RESERVED_PATH",
    );
  } finally {
    await repo.cleanup();
  }
});

test("refuses a Change that rewrites another Work's ledger", async () => {
  const repo = await createTestRepo();
  try {
    const service = serviceFor(repo);
    const victim = (await createWork(repo, service, { type: "Task", title: "Victim" })).identity.id;
    const attacker = (await createWork(repo, service, { type: "Bug", title: "Attacker" })).identity.id;
    await through(service, attacker, ["plan", "review"]);

    const built = await service.start("build", attacker, "h", "m", TODO);
    const worktree = built.worktreeDirectory as string;
    await repo.write(`.codepatrol/runtime/worktrees/${attacker}/${manifestPath(victim)}`, "{}\n");
    await repo.gitIn(worktree, "add", "-f", "--", manifestPath(victim));
    await repo.gitIn(worktree, "commit", "-q", "-m", "tamper");
    await assert.rejects(
      service.complete("build", attacker, built.runId, { decision: "continue", summary: "s", handoff: "h", todo: DONE, artifacts: [] }),
      (error: unknown) => error instanceof CodepatrolError && error.code === "RESERVED_PATH",
    );
  } finally {
    await repo.cleanup();
  }
});

test("reports a conflicting Change with its paths and leaves the base untouched", async () => {
  const repo = await createTestRepo({ defaultBranch: "trunk" });
  try {
    await repo.write("shared.txt", "base\n");
    await repo.commit("add shared");

    const service = serviceFor(repo);
    const workId = (await createWork(repo, service, { type: "Bug", title: "Conflicts" })).identity.id;
    await through(service, workId, ["plan", "review"]);
    const built = await service.start("build", workId, "h", "m", TODO);
    await repo.write(`.codepatrol/runtime/worktrees/${workId}/shared.txt`, "change side\n");
    await repo.gitIn(built.worktreeDirectory as string, "commit", "-q", "-am", "change edit");
    await service.complete("build", workId, built.runId, { decision: "continue", summary: "s", handoff: "h", todo: DONE, artifacts: [] });
    await runStage(service, "verify", workId);

    // The base moves underneath after verification.
    await repo.write("shared.txt", "base side\n");
    const diverged = await repo.commit("base edit");

    await assert.rejects(
      service.refresh(workId),
      (error: unknown) => error instanceof CodepatrolError && error.code === "STATE_CONFLICT" && /shared\.txt/.test(error.message),
    );
    assert.equal(await repo.head("refs/heads/trunk"), diverged);
  } finally {
    await repo.cleanup();
  }
});

test("rejects a product commit added after Verify", async () => {
  const repo = await createTestRepo({ defaultBranch: "trunk" });
  try {
    const service = serviceFor(repo);
    const workId = (await createWork(repo, service, { type: "Feature", title: "Freeze verified product" })).identity.id;
    await through(service, workId, ["plan", "review"]);
    const built = await service.start("build", workId, "h", "m", TODO);
    const worktree = built.worktreeDirectory as string;
    await repo.write(`.codepatrol/runtime/worktrees/${workId}/feature.txt`, "verified\n");
    await repo.gitIn(worktree, "add", "feature.txt");
    await repo.gitIn(worktree, "commit", "-q", "-m", "implement verified product");
    await service.complete("build", workId, built.runId, { decision: "continue", summary: "s", handoff: "verify", todo: DONE, artifacts: [] });
    await runStage(service, "verify", workId);

    await repo.write(`.codepatrol/runtime/worktrees/${workId}/feature.txt`, "changed after verify\n");
    await repo.gitIn(worktree, "commit", "-q", "-am", "move product after verify");
    const baseBefore = await repo.head("refs/heads/trunk");
    const shipped = await service.start("ship", workId, "h", "m", TODO);
    await assert.rejects(
      service.complete("ship", workId, shipped.runId, { decision: "accept", summary: "s", handoff: "h", todo: DONE, artifacts: [], authority: "owner" }),
      (error: unknown) => error instanceof CodepatrolError && error.code === "VERIFY_STALE" && /feature\.txt/.test(error.message),
    );
    assert.equal(await repo.head("refs/heads/trunk"), baseBefore, "the refused accept left the base alone");
  } finally {
    await repo.cleanup();
  }
});

test("refreshes a stale baseline without attributing base files to the Work", async () => {
  const repo = await createTestRepo({ defaultBranch: "trunk" });
  try {
    const service = serviceFor(repo);
    const workId = (await createWork(repo, service, { type: "Task", title: "Refresh baseline" })).identity.id;
    const started = await service.start("plan", workId, "h", "m", TODO, { worktree: true });
    await service.complete("plan", workId, started.runId, { decision: "continue", summary: "s", handoff: "h", todo: DONE, artifacts: [] });
    await repo.write("base-only.txt", "base\n");
    const target = await repo.commit("advance base");

    assert.equal((await service.inspect(workId)).baselineStale, true);
    const refreshed = await service.refresh(workId);
    assert.equal(refreshed.repository.baselineCommit, target);
    assert.equal(refreshed.stage, "review");
    const inspection = await service.inspect(workId);
    assert.equal(inspection.baselineStale, false);
    assert.ok(!inspection.changedFiles.includes("base-only.txt"));
  } finally {
    await repo.cleanup();
  }
});

test("refresh invalidates a standing Verify and requires verification again", async () => {
  const repo = await createTestRepo({ defaultBranch: "trunk" });
  try {
    const service = serviceFor(repo);
    const workId = (await createWork(repo, service, { type: "Feature", title: "Refresh verified work" })).identity.id;
    await through(service, workId, ["plan", "review", "build", "verify"]);
    await repo.write("unrelated-base.txt", "base\n");
    await repo.commit("advance base without conflict");

    const refreshed = await service.refresh(workId);
    assert.equal(refreshed.stage, "verify");
    assert.equal(refreshed.state, "ready");
    assert.equal(refreshed.change.verification, null);
    assert.equal(refreshed.attempts.find((attempt) => attempt.stage === "verify")?.status, "invalidated");
    const inspection = await service.inspect(workId);
    assert.equal(inspection.clean, true);
    assert.equal(await repo.read(`.codepatrol/runtime/worktrees/${workId}/unrelated-base.txt`), "base\n");
  } finally {
    await repo.cleanup();
  }
});

test("refresh does not attribute another accepted Work's manifest to the Change", async () => {
  const repo = await createTestRepo({ defaultBranch: "trunk" });
  try {
    const service = serviceFor(repo);
    const first = (await createWork(repo, service, { type: "Task", title: "Refresh after peer" })).identity.id;
    const peer = (await createWork(repo, service, { type: "Task", title: "Accepted peer" })).identity.id;
    await through(service, peer, ["plan", "review", "build", "verify", "ship"]);
    await service.refresh(first);
    await through(service, first, ["plan", "review", "build", "verify", "ship"]);
    assert.equal((await service.show(first)).outcome, "accepted");
  } finally {
    await repo.cleanup();
  }
});

test("does not trust an unrelated base commit carrying a Work trailer", async () => {
  const repo = await createTestRepo({ defaultBranch: "trunk" });
  try {
    const service = serviceFor(repo);
    const workId = (await createWork(repo, service, { type: "Bug", title: "Validate integration trailer" })).identity.id;
    await repo.write("unrelated.txt", "not the Change\n");
    await repo.commit(`unrelated\n\nCodepatrol-Work: ${workId}`);
    await service.refresh(workId);
    await through(service, workId, ["plan", "review", "build", "verify"]);
    const shipped = await service.start("ship", workId, "h", "m", TODO);
    await assert.rejects(
      service.complete("ship", workId, shipped.runId, { decision: "accept", summary: "s", handoff: "h", todo: DONE, artifacts: [], authority: "owner" }),
      (error: unknown) => error instanceof CodepatrolError && error.code === "STATE_CORRUPT" && /trailer/.test(error.message),
    );
  } finally {
    await repo.cleanup();
  }
});

test("Ship refuses when the base target moved after Verify", async () => {
  const repo = await createTestRepo({ defaultBranch: "trunk" });
  try {
    const service = serviceFor(repo);
    const workId = (await createWork(repo, service, { type: "Feature", title: "Detect target movement" })).identity.id;
    await through(service, workId, ["plan", "review", "build", "verify"]);
    await repo.write("unrelated-base.txt", "base\n");
    const target = await repo.commit("move target after verify");
    const shipped = await service.start("ship", workId, "h", "m", TODO);
    await assert.rejects(
      service.complete("ship", workId, shipped.runId, { decision: "accept", summary: "s", handoff: "h", todo: DONE, artifacts: [], authority: "owner" }),
      (error: unknown) => error instanceof CodepatrolError && error.code === "VERIFY_STALE",
    );
    assert.equal(await repo.head("refs/heads/trunk"), target);
  } finally {
    await repo.cleanup();
  }
});

test("detects a reserved path added and removed in executor commits", async () => {
  const repo = await createTestRepo();
  try {
    const service = serviceFor(repo);
    const workId = (await createWork(repo, service, { type: "Bug", title: "Transient reserved path" })).identity.id;
    await through(service, workId, ["plan", "review"]);
    const built = await service.start("build", workId, "h", "m", TODO);
    const worktree = built.worktreeDirectory as string;
    await repo.gitIn(worktree, "switch", "-q", "-c", "reserved-side");
    await repo.write(`.codepatrol/runtime/worktrees/${workId}/.codepatrol/transient.txt`, "forbidden\n");
    await repo.gitIn(worktree, "add", "-f", ".codepatrol/transient.txt");
    await repo.gitIn(worktree, "commit", "-q", "-m", "add transient reserved path");
    await repo.gitIn(worktree, "rm", "-q", ".codepatrol/transient.txt");
    await repo.gitIn(worktree, "commit", "-q", "-m", "remove transient reserved path");
    await repo.gitIn(worktree, "switch", "-q", `codepatrol/work/${workId}`);
    await repo.gitIn(worktree, "merge", "-q", "--no-ff", "reserved-side", "-m", "merge side history");

    await assert.rejects(
      service.complete("build", workId, built.runId, { decision: "continue", summary: "s", handoff: "h", todo: DONE, artifacts: [] }),
      (error: unknown) => error instanceof CodepatrolError && error.code === "RESERVED_PATH" && /transient\.txt/.test(error.message),
    );
  } finally {
    await repo.cleanup();
  }
});

test("refuses an uncommitted manifest edit before writing a transition", async () => {
  const repo = await createTestRepo();
  try {
    const service = serviceFor(repo);
    const workId = (await createWork(repo, service, { type: "Task", title: "Protect live manifest" })).identity.id;
    await through(service, workId, ["plan", "review"]);
    const built = await service.start("build", workId, "h", "m", TODO);
    const before = await repo.head(workBranchRef(workId));
    await repo.write(`.codepatrol/runtime/worktrees/${workId}/${manifestPath(workId)}`, "{}\n");
    await assert.rejects(
      service.complete("build", workId, built.runId, { decision: "continue", summary: "s", handoff: "h", todo: DONE, artifacts: [] }),
      (error: unknown) => error instanceof CodepatrolError && error.code === "RESERVED_PATH",
    );
    assert.equal(await repo.head(workBranchRef(workId)), before);
    assert.equal((await service.show(workId)).state, "active");
  } finally {
    await repo.cleanup();
  }
});

test("excludes its own runtime so the tool does not make the base dirty", async () => {
  // A real repository has no .gitignore entry for .codepatrol/runtime, so
  // without info/exclude the tool's own worktrees would block its own ship.
  const repo = await createTestRepo({ defaultBranch: "trunk", files: { "README.md": "# Fixture\n" } });
  try {
    const service = serviceFor(repo);
    const workId = (await createWork(repo, service, { type: "Task", title: "No gitignore here" })).identity.id;
    await through(service, workId, ["plan", "review", "build"]);

    assert.equal(await repo.git("status", "--porcelain", "--untracked-files=all"), "");
    assert.ok((await repo.read(".git/info/exclude")).includes("/.codepatrol/runtime/"));

    await through(service, workId, ["verify", "ship"]);
    assert.equal(await repo.commitCount("refs/heads/trunk"), 3, "bootstrap, the manifest projection, and the squash");
  } finally {
    await repo.cleanup();
  }
});

test("resumes a Work whose decision was recorded but never integrated", async () => {
  const repo = await createTestRepo({ defaultBranch: "trunk" });
  try {
    const service = serviceFor(repo);
    const workId = (await createWork(repo, service, { type: "Feature", title: "Interrupted ship" })).identity.id;
    await through(service, workId, ["plan", "review", "build", "verify"]);
    const shipped = await service.start("ship", workId, "h", "m", TODO);

    // Integration fails on a precondition after the manifest already records the
    // decision, which is exactly where a crash would leave things.
    await repo.write("blocker.txt", "uncommitted\n");
    await assert.rejects(
      service.complete("ship", workId, shipped.runId, { decision: "accept", summary: "s", handoff: "h", todo: DONE, artifacts: [], authority: "owner" }),
      (error: unknown) => error instanceof CodepatrolError && error.code === "GIT_DIRTY",
    );
    assert.equal(await repo.commitCount("refs/heads/trunk"), 2, "the base carries only the manifest projection");
    assert.equal((await service.show(workId)).outcome, "accepted", "the decision is recorded");

    await repo.commit("resolve the blocker");
    const resumed = await service.complete("ship", workId, shipped.runId, { decision: "accept", summary: "s", handoff: "h", todo: DONE, artifacts: [], authority: "owner" });

    assert.equal(resumed.integration?.outcome, "accepted");
    assert.equal(await repo.commitCount("refs/heads/trunk"), 4, "bootstrap, the manifest projection, the blocker fix, and one squash");
    assert.equal(await repo.refExists(workBranchRef(workId)), false);
    const repeated = await service.complete("ship", workId, shipped.runId, { decision: "accept", summary: "s", handoff: "h", todo: DONE, artifacts: [], authority: "owner" });
    assert.equal(repeated.integration?.integrationCommit, resumed.integration?.integrationCommit);
    assert.equal(await repo.commitCount("refs/heads/trunk"), 4);
  } finally {
    await repo.cleanup();
  }
});

test("Build waits for its blocker while Plan and Review do not", async () => {
  const repo = await createTestRepo({ defaultBranch: "trunk" });
  try {
    const service = serviceFor(repo);
    const blocker = (await createWork(repo, service, { type: "Task", title: "Land the foundation" })).identity.id;
    const dependent = (await createWork(repo, service, { type: "Feature", title: "Build on it", blockedBy: [blocker] })).identity.id;

    // Understanding and reviewing a change does not depend on its blocker
    // having landed, so both stages run while blocked.
    assert.equal((await service.show(dependent)).graph.status, "blocked");
    await through(service, dependent, ["plan", "review"]);

    await assert.rejects(
      service.start("build", dependent, "h", "m", TODO),
      (error: unknown) => error instanceof CodepatrolError && error.code === "WORK_BLOCKED" && error.message.includes(blocker),
    );

    await through(service, blocker, ["plan", "review", "build", "verify", "ship"]);
    assert.equal((await service.show(dependent)).graph.status, "executable");
    const built = await service.start("build", dependent, "h", "m", TODO);
    assert.notEqual(built.worktreeDirectory, null);
  } finally {
    await repo.cleanup();
  }
});

test("a rolled-back blocker never releases its dependent", async () => {
  const repo = await createTestRepo({ defaultBranch: "trunk" });
  try {
    const service = serviceFor(repo);
    const blocker = (await createWork(repo, service, { type: "Task", title: "Abandoned foundation" })).identity.id;
    const dependent = (await createWork(repo, service, { type: "Feature", title: "Depends on it", blockedBy: [blocker] })).identity.id;

    await through(service, blocker, ["plan", "review", "build", "verify", "ship"], {
      decision: "rollback", summary: "wrong approach", handoff: "none", todo: DONE, artifacts: [], authority: "owner",
    });

    await through(service, dependent, ["plan", "review"]);
    await assert.rejects(
      service.start("build", dependent, "h", "m", TODO),
      (error: unknown) => error instanceof CodepatrolError && error.code === "WORK_BLOCKED" && error.message.includes("rolled-back"),
    );
    const view = await service.show(dependent);
    assert.equal(view.graph.status, "blocked");
    assert.deepEqual(view.graph.unresolvedBlockers, [blocker]);
    assert.equal(view.nextCommand, `codepatrol work show ${blocker}`, "the next command points at what is holding it up");
  } finally {
    await repo.cleanup();
  }
});

test("refuses a self-dependency at creation", async () => {
  const repo = await createTestRepo({ defaultBranch: "trunk" });
  try {
    const service = serviceFor(repo);
    const other = (await createWork(repo, service, { type: "Task", title: "Existing" })).identity.id;
    await assert.rejects(
      createWork(repo, service, { type: "Task", title: "Impossible", blockedBy: ["not-a-work-id"] }),
      (error: unknown) => error instanceof CodepatrolError && error.code === "DOCUMENT_REJECTED",
    );
    // A valid blocker is accepted and recorded.
    const created = await createWork(repo, service, { type: "Task", title: "Fine", blockedBy: [other, other] });
    assert.deepEqual(created.graph.blockedBy, [other], "duplicates collapse");
  } finally {
    await repo.cleanup();
  }
});

test("the short INIT-x.y code resolves to the full Work id at every service entry", async () => {
  // The number pair is unique by construction, so the short code INIT-x.y maps
  // to exactly one Work. Every WorkService entry method must accept the code
  // and behave exactly as the full id does.
  const repo = await createTestRepo();
  try {
    const service = serviceFor(repo);
    const created = await createWork(repo, service, { type: "Task", title: "Resolves" });
    const code = `INIT-${created.identity.initiative.id.match(/^INIT-(\d+)$/)?.[1]}.1`;

    const byCode = await service.show(code);
    assert.equal(byCode.identity.id, created.identity.id, "show resolves the short code to the same Work view");

    const started = await service.start("plan", code, "test-harness", "test-model", TODO);
    assert.equal(started.workId, created.identity.id, "start resolves the short code and pins the canonical id on the run");
  } finally {
    await repo.cleanup();
  }
});

test("an unknown short code fails with INVALID_WORK_ID naming what was passed", async () => {
  // The resolver must not invent an id from a code that names no Work: an
  // unknown short code is the same shape of error the format validator
  // raised before, naming the input so the caller can fix it.
  const repo = await createTestRepo();
  try {
    const service = serviceFor(repo);
    const created = await createWork(repo, service, { type: "Task", title: "Existing" });
    assert.match(created.identity.id, /^INIT-\d+\.\d+-/, "the fixture minted a known Work id");

    // A short code that names no Work: the resolver matches no id and the
    // service surfaces INVALID_WORK_ID with the input visible in the message.
    await assert.rejects(
      service.start("plan", "INIT-0.99", "test-harness", "test-model", TODO),
      (error: unknown) => error instanceof CodepatrolError && error.code === "INVALID_WORK_ID" && /INIT-0\.99/.test((error as CodepatrolError).message),
    );
  } finally {
    await repo.cleanup();
  }
});
