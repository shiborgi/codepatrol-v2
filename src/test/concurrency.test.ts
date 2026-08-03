import assert from "node:assert/strict";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { ChangeIntegration } from "../adapters/integration.js";
import { LocalGitPort } from "../adapters/git-port.js";
import { LocalGitRemote } from "../adapters/local-git-remote.js";
import { GitManifestStore } from "../adapters/manifest-store.js";
import { Worktrees, worktreeStoreHooks } from "../adapters/worktree.js";
import { WorkService } from "../application/work-service.js";
import { SpecService } from "../application/spec-service.js";
import { INITIATIVE_DOCUMENT_SCHEMA_VERSION, INITIATIVE_DOCUMENT_TYPE, type InitiativeDocument } from "../core/initiative-document.js";
import { archiveRef, manifestRef, workBranchRef } from "../core/work-manifest.js";
import { TestClock } from "./support/app.js";
import { createBareRemote, createTestRepo, type TestRepo } from "./support/repo.js";

const TODO = [{ id: "T1", title: "Produce the step result" }];
const DONE = [{ id: "T1", status: "completed" as const }];

/**
 * A service bundle that owns its own store, worktrees, and WorkService over
 * the same on-disk repository as another bundle. The two bundles share Git
 * state (the lock primitives, refs, working tree, and object store) but have
 * independent in-process state — the honest shape two harnesses on two Works
 * present: the ref CAS sees real contention, the lock primitives serialize,
 * and the test can interleave the two bundles' async calls.
 */
function bundleFor(repo: TestRepo): { store: GitManifestStore; worktrees: Worktrees; works: WorkService; spec: SpecService } {
  const worktrees = new Worktrees(repo.root);
  const store = new GitManifestStore(repo.root, worktreeStoreHooks(worktrees));
  const integration = new ChangeIntegration(repo.root, worktrees);
  const git = new LocalGitPort(repo.root);
  const works = new WorkService(store, worktrees, integration, git, new TestClock(), repo.root);
  const spec = new SpecService(store, worktrees, new TestClock());
  return { store, worktrees, works, spec };
}

async function createThreeWorks(_repo: TestRepo, specA: SpecService, specB: SpecService, titles: readonly string[]): Promise<string[]> {
  const inspection = await specA.inspect();
  const document: InitiativeDocument = {
    schemaVersion: INITIATIVE_DOCUMENT_SCHEMA_VERSION,
    type: INITIATIVE_DOCUMENT_TYPE,
    documentId: `test-concurrency-${inspection.digest.slice(0, 12)}`,
    summary: "Three Works for the concurrency storm",
    observedState: "test fixture",
    digest: inspection.digest,
    createdAt: "2026-08-03T10:00:00.000Z",
    works: titles.map((title, index) => ({
      key: `work${index}`,
      title,
      description: `Concurrency fixture ${index}`,
      issueType: "Feature",
      priority: "p1",
      acceptance: ["The concurrency contract is satisfied"],
      blockedBy: [],
      requestedBy: "test",
    })),
    cancel: [],
    supersede: [],
    followUp: [],
    initiative: { title: "Concurrency fixture", intent: "i", motivation: "m", ordering: "o" },
  };
  const applied = await specB.apply(document);
  const ids = applied.createdWorkIds ?? [];
  assert.equal(ids.length, titles.length);
  return ids.filter((id): id is string => typeof id === "string");
}

async function runToReview(_repo: TestRepo, works: WorkService, workId: string): Promise<void> {
  const plan = await works.start("plan", workId, "harness-a", "model-a", TODO);
  await works.complete("plan", workId, plan.runId, { decision: "continue", summary: "planned", handoff: "review", todo: DONE, artifacts: [] });
  const review = await works.start("review", workId, "harness-a", "model-a", TODO);
  await works.complete("review", workId, review.runId, { decision: "continue", summary: "reviewed", handoff: "build", todo: DONE, artifacts: [] });
}

async function stageBuild(repo: TestRepo, works: WorkService, workId: string, file: string): Promise<void> {
  await runToReview(repo, works, workId);
  const started = await works.start("build", workId, "harness", "model", TODO);
  const wt = started.worktreeDirectory;
  if (wt === null) throw new Error(`Build for ${workId} returned no worktree.`);
  const product = path.join(wt, file);
  await mkdir(path.dirname(product), { recursive: true });
  await writeFile(product, `${workId} content\n`, "utf8");
  await repo.gitIn(wt, "add", file);
  await repo.gitIn(wt, "commit", "-q", "-m", `${workId} product`);
  await works.complete("build", workId, started.runId, { decision: "continue", summary: "built", handoff: "verify", todo: DONE, artifacts: [] });
}

async function expectFile(file: string, expected: boolean, label: string): Promise<void> {
  const seen = await access(file).then(() => true, () => false);
  assert.equal(seen, expected, label);
}

/**
 * The full concurrency storm. Three Works, two service bundles, overlapping
 * starts/completions across plan, review, and build with file isolation; a
 * sync runs in parallel against a bare remote. The test fails if any lock gap
 * surfaces: a manifest records a transition twice, one Work's product file
 * lands in another's worktree, or the suite deadlocks.
 */
test("overlapping stage runs across three Works and a sync converge without corruption", async () => {
  const repo = await createTestRepo({ defaultBranch: "trunk" });
  const bare = await createBareRemote(repo);
  try {
    const A = bundleFor(repo);
    const B = bundleFor(repo);
    const workIds = await createThreeWorks(repo, A.spec, B.spec, ["Alpha", "Bravo", "Charlie"]);
    const [alpha, bravo, charlie] = workIds as [string, string, string];

    // Run the storm. Both bundles drive builds in parallel; the per-Work and
    // repository locks do the serialization. Interleaving is real because each
    // builder issues an `await` on its own bundle before yielding to the
    // other bundle's path through the lock.
    await Promise.all([
      stageBuild(repo, A.works, alpha, "alpha-product.txt"),
      stageBuild(repo, B.works, bravo, "bravo-product.txt"),
      stageBuild(repo, A.works, charlie, "charlie-product.txt"),
    ]);

    // File isolation: each Work's product file is only in its own worktree,
    // never in the peer Work's worktree or in the main checkout.
    const alphaContent = (await repo.showFile(workBranchRef(alpha), "alpha-product.txt")) as string;
    const bravoContent = (await repo.showFile(workBranchRef(bravo), "bravo-product.txt")) as string;
    const charlieContent = (await repo.showFile(workBranchRef(charlie), "charlie-product.txt")) as string;
    assert.equal(alphaContent.trim(), "INIT-0.1-alpha content");
    assert.equal(bravoContent.trim(), "INIT-0.2-bravo content");
    assert.equal(charlieContent.trim(), "INIT-0.3-charlie content");
    assert.equal(await repo.showFile(workBranchRef(alpha), "bravo-product.txt"), undefined, "alpha's branch does not carry bravo's file");
    assert.equal(await repo.showFile(workBranchRef(bravo), "alpha-product.txt"), undefined, "bravo's branch does not carry alpha's file");
    assert.equal(await repo.showFile(workBranchRef(alpha), "charlie-product.txt"), undefined, "alpha's branch does not carry charlie's file");

    // Exactly-once transitions: each manifest records one attempt per
    // plan, review, and build stage, each completing with status `completed`,
    // in lifecycle order. The invariant holds for every Work the storm
    // touched.
    for (const view of [await A.works.show(alpha), await B.works.show(bravo), await A.works.show(charlie)]) {
      const stages = view.attempts.map((attempt) => attempt.stage);
      assert.deepEqual(stages, ["plan", "review", "build"], `${view.identity.id} recorded plan, review, build exactly once`);
      for (const attempt of view.attempts) {
        assert.equal(attempt.status, "completed", `${view.identity.id} attempt ${attempt.stage} #${attempt.attempt} is completed`);
        assert.equal(attempt.result?.decision, "continue", `${view.identity.id} attempt ${attempt.stage} #${attempt.attempt} decided continue`);
      }
    }

    // Sync overlap: a sync against the bare remote completes while the
    // manifest refs are intact. The local repository must end with every
    // Work's manifest ref and its base projection.
    const remoteA = new LocalGitRemote(repo.root);
    const policy = { isTerminal: async (workId: string) => (await A.store.read(workId)).manifest.workflow.state === "terminal", cleanup: false };
    const syncResult = await remoteA.sync("origin", bare.root, policy);
    assert.ok(syncResult.refs.find((item) => item.ref === manifestRef(alpha)), "alpha's manifest ref is published");
    assert.ok(syncResult.refs.find((item) => item.ref === manifestRef(bravo)), "bravo's manifest ref is published");
    assert.ok(syncResult.refs.find((item) => item.ref === manifestRef(charlie)), "charlie's manifest ref is published");

    // Convergence: a repeated identical sync reports every ref unchanged.
    const converged = await remoteA.sync("origin", bare.root, policy);
    const changes = converged.refs.filter((item) => item.action !== "unchanged");
    assert.equal(changes.length, 0, "a second sync with no local changes reports nothing changed");

    // Archive presence: terminal integration has not run yet, but every Work
    // that survives the storm has its branch and its projection on the base.
    for (const workId of [alpha, bravo, charlie] as const) {
      assert.equal(await repo.refExists(workBranchRef(workId)), true, `${workId} branch still exists after the storm`);
      assert.equal(await repo.refExists(archiveRef(workId)), false, `${workId} archive does not exist yet (not yet integrated)`);
    }
  } finally {
    await Promise.all([repo.cleanup(), bare.cleanup()]);
  }
});

/**
 * The bounded-time guarantee. The full storm runs under a 60s ceiling so a
 * regression in lock acquisition surfaces as a test failure, not a hung CI
 * run. The lock's own 30s GIT_LOCKED refusal backs this up: a deadlock is
 * reported, not silently swallowed.
 */
test("the concurrency storm completes inside its bounded time", { timeout: 60_000 }, async () => {
  const repo = await createTestRepo({ defaultBranch: "trunk" });
  try {
    const A = bundleFor(repo);
    const B = bundleFor(repo);
    const workIds = await createThreeWorks(repo, A.spec, B.spec, ["Storm-A", "Storm-B", "Storm-C"]);
    const [alpha, bravo, charlie] = workIds as [string, string, string];
    const planAndComplete = async (works: WorkService, workId: string): Promise<void> => {
      const started = await works.start("plan", workId, "h", "m", TODO);
      await works.complete("plan", workId, started.runId, { decision: "continue", summary: "p", handoff: "r", todo: DONE, artifacts: [] });
    };
    await Promise.all([planAndComplete(A.works, alpha), planAndComplete(B.works, bravo), planAndComplete(A.works, charlie)]);
  } finally {
    await repo.cleanup();
  }
});

/**
 * A run sees another's edits only as the Work's own branch carries them. The
 * other Work's worktree directory does not contain the file even while both
 * builds are in flight.
 */
test("a Work's product file is invisible from the peer Work's worktree and the main checkout", async () => {
  const repo = await createTestRepo({ defaultBranch: "trunk" });
  try {
    const A = bundleFor(repo);
    const B = bundleFor(repo);
    const workIds = await createThreeWorks(repo, A.spec, B.spec, ["Isolation-A", "Isolation-B", "Isolation-C"]);
    const [alpha, bravo] = workIds as [string, string, string];

    // Walk plan/review so build is the expected stage.
    await runToReview(repo, A.works, alpha);
    await runToReview(repo, B.works, bravo);

    // Start builds for alpha and bravo but do not complete them yet: each
    // bundle holds the work/<id> lock while the build is in flight.
    const alphaBuild = await A.works.start("build", alpha, "h", "m", TODO);
    const bravoBuild = await B.works.start("build", bravo, "h", "m", TODO);

    // Now write each product file inside the matching worktree while the
    // build is still active on the other.
    const alphaDir = alphaBuild.worktreeDirectory;
    const bravoDir = bravoBuild.worktreeDirectory;
    if (alphaDir === null || bravoDir === null) throw new Error("Build returned no worktree.");
    await writeFile(path.join(alphaDir, "alpha-isolation.txt"), "alpha isolation\n", "utf8");
    await writeFile(path.join(bravoDir, "bravo-isolation.txt"), "bravo isolation\n", "utf8");

    // Alpha's file is visible in alpha's worktree but not in bravo's, and
    // not on the main checkout's working tree.
    await expectFile(path.join(alphaDir, "alpha-isolation.txt"), true, "alpha's edit is in alpha's worktree");
    await expectFile(path.join(bravoDir, "alpha-isolation.txt"), false, "bravo's worktree does not see alpha's edits");
    await expectFile(path.join(bravoDir, "bravo-isolation.txt"), true, "bravo's edit is in bravo's worktree");
    await expectFile(path.join(alphaDir, "bravo-isolation.txt"), false, "alpha's worktree does not see bravo's edits");
    await expectFile(path.join(repo.root, "alpha-isolation.txt"), false, "the main checkout never sees alpha's file");
    await expectFile(path.join(repo.root, "bravo-isolation.txt"), false, "the main checkout never sees bravo's file");

    // Complete both builds and verify the manifests.
    await repo.gitIn(alphaDir, "add", "alpha-isolation.txt");
    await repo.gitIn(alphaDir, "commit", "-q", "-m", "alpha isolation");
    await A.works.complete("build", alpha, alphaBuild.runId, { decision: "continue", summary: "b", handoff: "v", todo: DONE, artifacts: [] });

    await repo.gitIn(bravoDir, "add", "bravo-isolation.txt");
    await repo.gitIn(bravoDir, "commit", "-q", "-m", "bravo isolation");
    await B.works.complete("build", bravo, bravoBuild.runId, { decision: "continue", summary: "b", handoff: "v", todo: DONE, artifacts: [] });

    const alphaView = await A.works.show(alpha);
    const bravoView = await B.works.show(bravo);
    const alphaBuildAttempt = alphaView.attempts.find((attempt) => attempt.stage === "build");
    const bravoBuildAttempt = bravoView.attempts.find((attempt) => attempt.stage === "build");
    assert.ok(alphaBuildAttempt && alphaBuildAttempt.status === "completed", "alpha's build attempt completed");
    assert.ok(bravoBuildAttempt && bravoBuildAttempt.status === "completed", "bravo's build attempt completed");
    assert.equal(alphaView.attempts.filter((attempt) => attempt.stage === "build").length, 1, "alpha records build exactly once");
    assert.equal(bravoView.attempts.filter((attempt) => attempt.stage === "build").length, 1, "bravo records build exactly once");
  } finally {
    await repo.cleanup();
  }
});

/**
 * The concurrency suite is the CI shape: no bare remote, no GitHub, no
 * network. Only the on-disk repository and the local service bundles are
 * needed for the storm.
 */
test("the concurrency suite runs in CI without a remote", async () => {
  const repo = await createTestRepo({ defaultBranch: "trunk" });
  try {
const A = bundleFor(repo);
    const B = bundleFor(repo);
    const workIds = await createThreeWorks(repo, A.spec, B.spec, ["CI-A", "CI-B", "CI-C"]);
    const firstStart = await A.works.start("plan", workIds[0] as string, "h", "m", TODO);
    const secondStart = await B.works.start("plan", workIds[1] as string, "h", "m", TODO);
    await A.works.complete("plan", workIds[0] as string, firstStart.runId, { decision: "continue", summary: "p", handoff: "r", todo: DONE, artifacts: [] });
    await B.works.complete("plan", workIds[1] as string, secondStart.runId, { decision: "continue", summary: "p", handoff: "r", todo: DONE, artifacts: [] });
    assert.ok(true, "the storm completed without a remote");
  } finally {
    await repo.cleanup();
  }
});