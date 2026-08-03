import assert from "node:assert/strict";
import test from "node:test";
import { LocalGitRemote } from "../adapters/local-git-remote.js";
import { GitManifestStore } from "../adapters/manifest-store.js";
import { Worktrees, worktreeStoreHooks } from "../adapters/worktree.js";
import { SpecService } from "../application/spec-service.js";
import { CodepatrolError } from "../core/errors.js";
import { INITIATIVE_DOCUMENT_SCHEMA_VERSION, INITIATIVE_DOCUMENT_TYPE, parseInitiativeDocument, type InitiativeDocument } from "../core/initiative-document.js";
import { initiativeOfWork } from "../core/initiative.js";
import { archiveRef, manifestRef, workBranchRef } from "../core/work-manifest.js";
import { createTestApp, DONE_TODO, TODO } from "./support/app.js";
import { createBareRemote, createTestRepo } from "./support/repo.js";

function policy(store: GitManifestStore): { isTerminal(workId: string): Promise<boolean>; cleanup: boolean } {
  return { isTerminal: async (workId) => (await store.read(workId)).manifest.workflow.state === "terminal", cleanup: true };
}

test("pulls a remote-only Work by its manifest ref", async () => {
  const source = await createTestApp();
  const target = await createTestRepo();
  const bare = await createBareRemote(source.repo);
  try {
    const workId = await source.createWork({ title: "Remote Work" });
    await new LocalGitRemote(source.repo.root).sync("origin", bare.root, policy(source.store));

    const targetStore = new GitManifestStore(target.root);
    await new LocalGitRemote(target.root).sync("origin", bare.root, policy(targetStore));

    assert.equal(await target.head(manifestRef(workId)), await source.repo.head(manifestRef(workId)));
    assert.equal(await target.refExists(workBranchRef(workId)), false, "a branchless Work stays branchless across sync");
    assert.equal((await targetStore.read(workId)).manifest.work.id, workId);
  } finally {
    await Promise.all([source.cleanup(), target.cleanup(), bare.cleanup()]);
  }
});

test("refuses to fast-forward a dirty checked-out branch", async () => {
  const source = await createTestRepo();
  const target = await createTestRepo();
  const bare = await createBareRemote(source);
  try {
    const noTerminal = { isTerminal: async () => false };
    const sourceRemote = new LocalGitRemote(source.root);
    const targetRemote = new LocalGitRemote(target.root);
    await sourceRemote.sync("origin", bare.root, noTerminal);
    await targetRemote.sync("origin", bare.root, noTerminal);
    await source.write("remote.txt", "remote\n");
    await source.commit("advance remote");
    await sourceRemote.sync("origin", bare.root, noTerminal);
    await target.write("README.md", "dirty\n");

    await assert.rejects(
      targetRemote.sync("origin", bare.root, noTerminal),
      (error: unknown) => error instanceof CodepatrolError && error.code === "GIT_DIRTY",
    );
    assert.equal(await target.read("README.md"), "dirty\n");
  } finally {
    await Promise.all([source.cleanup(), target.cleanup(), bare.cleanup()]);
  }
});

test("replaces a stale local active branch with a terminal remote archive", async () => {
  const source = await createTestApp();
  const target = await createTestRepo();
  const bare = await createBareRemote(source.repo);
  try {
    const workId = await source.createWork({ title: "Shipped elsewhere" });
    const sourceRemote = new LocalGitRemote(source.repo.root);
    const targetStore = new GitManifestStore(target.root);
    const targetRemote = new LocalGitRemote(target.root);
    // The Work opens its branch at Build, before the first sync, so the target
    // receives an active branch it will later have to let go.
    await source.runThrough(workId, "build");
    await sourceRemote.sync("origin", bare.root, policy(source.store));
    await targetRemote.sync("origin", bare.root, policy(targetStore));
    assert.equal(await target.refExists(workBranchRef(workId)), true);

    await source.runThrough(workId);
    await sourceRemote.sync("origin", bare.root, policy(source.store));
    await targetRemote.sync("origin", bare.root, policy(targetStore));

    assert.equal(await target.refExists(workBranchRef(workId)), false);
    assert.equal(await target.refExists(archiveRef(workId)), true);
    const terminal = await targetStore.read(workId);
    assert.equal(terminal.source, "manifest", "the manifest ref is the authority the target reads");
    assert.equal(terminal.manifest.workflow.state, "terminal");
  } finally {
    await Promise.all([source.cleanup(), target.cleanup(), bare.cleanup()]);
  }
});

test("deletes the terminal working branch remotely and never touches the archive", async () => {
  const source = await createTestApp();
  const bare = await createBareRemote(source.repo);
  try {
    const workId = await source.createWork({ title: "Terminal sync" });
    const remote = new LocalGitRemote(source.repo.root);
    await source.runThrough(workId, "build");
    await remote.sync("origin", bare.root, policy(source.store));
    assert.equal(await bare.refExists(workBranchRef(workId)), true, "the active branch is published");

    await source.runThrough(workId);
    const archiveHead = await source.repo.head(archiveRef(workId));
    await remote.sync("origin", bare.root, policy(source.store));

    assert.equal(await bare.refExists(workBranchRef(workId)), false, "the working branch is deleted once the Work is terminal");
    assert.equal(await bare.head(archiveRef(workId)), archiveHead, "the archive reached the remote");

    // Repeated synchronization is a no-op for the terminal record: the archive
    // is neither advanced nor deleted.
    await remote.sync("origin", bare.root, policy(source.store));
    assert.equal(await bare.head(archiveRef(workId)), archiveHead, "a repeated sync leaves the archive untouched");
    assert.equal(await bare.refExists(workBranchRef(workId)), false);
  } finally {
    await Promise.all([source.cleanup(), bare.cleanup()]);
  }
});

test("retains an interrupted terminal branch until integration creates its archive", async () => {
  const source = await createTestApp();
  const bare = await createBareRemote(source.repo);
  try {
    const workId = await source.createWork({ title: "Interrupted Ship" });
    const remote = new LocalGitRemote(source.repo.root);
    await remote.sync("origin", bare.root, policy(source.store));
    const remotePointerBefore = await bare.head(manifestRef(workId));
    await source.runThrough(workId, "verify");
    const shipped = await source.works.start("ship", workId, "h", "m", TODO);
    await source.repo.write("README.md", "dirty base\n");
    await assert.rejects(
      source.works.complete("ship", workId, shipped.runId, {
        decision: "accept",
        summary: "accepted but not integrated",
        handoff: "terminal",
        todo: DONE_TODO,
        artifacts: [],
        authority: "owner",
      }),
      (error: unknown) => error instanceof CodepatrolError && error.code === "GIT_DIRTY",
    );

    await remote.sync("origin", bare.root, policy(source.store));

    // The branch appeared only after the first sync, and the Work turned
    // terminal before the archive existed: nothing of it is published yet, and
    // locally it survives until integration creates the archive.
    assert.equal(await source.repo.refExists(workBranchRef(workId)), true);
    assert.equal(await source.repo.refExists(archiveRef(workId)), false);
    assert.equal(await bare.refExists(workBranchRef(workId)), false, "an incomplete terminal Work publishes no branch");
    assert.equal(await bare.head(manifestRef(workId)), remotePointerBefore, "its terminal decision is not published before integration");
  } finally {
    await Promise.all([source.cleanup(), bare.cleanup()]);
  }
});

async function initiativeDocument(spec: SpecService, options: { title: string; intent: string; workTitle: string }): Promise<InitiativeDocument> {
  const inspection = await spec.inspect();
  return parseInitiativeDocument({
    schemaVersion: INITIATIVE_DOCUMENT_SCHEMA_VERSION,
    type: INITIATIVE_DOCUMENT_TYPE,
    documentId: `doc-${inspection.digest.slice(0, 12)}`,
    summary: "Initiative refs round-trip",
    observedState: "round-trip",
    digest: inspection.digest,
    createdAt: "2026-08-01T00:00:00.000Z",
    initiative: { title: options.title, intent: options.intent, motivation: "test", ordering: "test" },
    works: [{
      key: "work",
      title: options.workTitle,
      description: "Initiative ref round-trip",
      issueType: "Task",
      priority: "p1",
      acceptance: ["The Initiative ref round-trips through the remote"],
    }],
    cancel: [],
    supersede: [],
    followUp: [],
  });
}

test("publishes every local Initiative ref and a fresh clone reads the same documents back", async () => {
  const source = await createTestApp();
  const target = await createTestRepo();
  const bare = await createBareRemote(source.repo);
  try {
    const workId = await source.createWork({ title: "Initiative ref travels" });
    const initiativeId = initiativeOfWork(workId);
    assert.ok(initiativeId, "the Work belongs to a minted Initiative");
    const initiativeRef = `refs/codepatrol/initiative/${initiativeId}-test-initiative`;

    await new LocalGitRemote(source.repo.root).sync("origin", bare.root, policy(source.store));
    assert.equal(await bare.refExists(initiativeRef), true, "the local Initiative ref is published to the remote");
    assert.equal(await bare.head(initiativeRef), await source.repo.head(initiativeRef), "the remote Initiative ref carries the same commit");

    const targetStore = new GitManifestStore(target.root);
    await new LocalGitRemote(target.root).sync("origin", bare.root, policy(targetStore));
    const initiatives = await targetStore.listInitiatives();
    assert.equal(initiatives.length, 1);
    assert.equal(initiatives[0]?.id, initiativeId);
    assert.equal(initiatives[0]?.title, "Test initiative");
    assert.equal(initiatives[0]?.intent, "i");
    assert.equal(await target.head(initiativeRef), await source.repo.head(initiativeRef), "the target received the Initiative ref at the same commit");
  } finally {
    await Promise.all([source.cleanup(), target.cleanup(), bare.cleanup()]);
  }
});

test("a second clone mints the next free Initiative number rather than one already taken", async () => {
  const source = await createTestApp();
  const target = await createTestRepo();
  const bare = await createBareRemote(source.repo);
  try {
    const firstWork = await source.createWork({ title: "First cloned Work" });
    assert.equal(initiativeOfWork(firstWork), "INIT-0");

    await new LocalGitRemote(source.repo.root).sync("origin", bare.root, policy(source.store));

    // A fresh clone receives the source's Initiative refs. The next Initiative
    // minted on target must use the next free number, proving fetch walked
    // the remote's Initiative ref set rather than starting from scratch.
    const targetWorktrees = new Worktrees(target.root);
    const targetStore = new GitManifestStore(target.root, worktreeStoreHooks(targetWorktrees));
    const targetSpec = new SpecService(targetStore, targetWorktrees);
    const targetRemote = new LocalGitRemote(target.root);
    await targetRemote.sync("origin", bare.root, { isTerminal: async () => false });

    const applied = await targetSpec.apply(await initiativeDocument(targetSpec, { title: "Next Initiative", intent: "i", workTitle: "Follow-up Work" }));
    const secondWork = applied.createdWorkIds?.[0];
    assert.ok(secondWork);
    assert.equal(initiativeOfWork(secondWork), "INIT-1", "the second clone skips the number already taken on the remote");
  } finally {
    await Promise.all([source.cleanup(), target.cleanup(), bare.cleanup()]);
  }
});

test("a scoped sync publishes only the selected Work's Initiative, not the other", async () => {
  const source = await createTestApp();
  const bare = await createBareRemote(source.repo);
  try {
    const firstWork = await source.createWork({ title: "First Initiative's Work" });
    assert.equal(initiativeOfWork(firstWork), "INIT-0");

    const applied = await source.spec.apply(await initiativeDocument(source.spec, { title: "Second Initiative", intent: "second", workTitle: "Second Initiative's Work" }));
    const secondWork = applied.createdWorkIds?.[0];
    assert.ok(secondWork);
    assert.equal(initiativeOfWork(secondWork), "INIT-1");

    const remote = new LocalGitRemote(source.repo.root);
    const result = await remote.sync("origin", bare.root, policy(source.store), { workId: secondWork });

    const pushedInitiativeRefs = result.refs.filter((item) => item.action === "pushed" && item.ref.startsWith("refs/codepatrol/initiative/")).map((item) => item.ref);
    assert.equal(pushedInitiativeRefs.length, 1, "exactly one Initiative ref was pushed");
    assert.match(pushedInitiativeRefs[0] ?? "", /^refs\/codepatrol\/initiative\/INIT-1-/, "the pushed Initiative is the one the selected Work belongs to");
    assert.equal(await bare.refExists(`refs/codepatrol/initiative/${initiativeOfWork(firstWork)}-test-initiative`), false, "the unselected Initiative never reaches the remote on a scoped sync");
    assert.equal(await bare.refExists(`refs/codepatrol/initiative/${initiativeOfWork(secondWork)}-second-initiative`), true, "the selected Initiative is published");
  } finally {
    await Promise.all([source.cleanup(), bare.cleanup()]);
  }
});

test("never deletes an Initiative ref, even after every Work of that Initiative is terminal", async () => {
  const source = await createTestApp();
  const bare = await createBareRemote(source.repo);
  try {
    const workId = await source.createWork({ title: "Terminal Initiative" });
    const initiativeId = initiativeOfWork(workId);
    assert.ok(initiativeId);
    const initiativeRef = `refs/codepatrol/initiative/${initiativeId}-test-initiative`;

    await source.runThrough(workId, "build");
    const remote = new LocalGitRemote(source.repo.root);
    await remote.sync("origin", bare.root, policy(source.store));
    assert.equal(await source.repo.refExists(initiativeRef), true, "the Initiative ref exists locally after first sync");
    assert.equal(await bare.refExists(initiativeRef), true, "the Initiative ref reaches the remote after first sync");

    await source.runThrough(workId);
    await remote.sync("origin", bare.root, policy(source.store));

    assert.equal(await bare.refExists(workBranchRef(workId)), false, "the terminal working branch is deleted remotely");
    assert.equal(await bare.refExists(archiveRef(workId)), true, "the archive is published");
    assert.equal(await bare.refExists(initiativeRef), true, "the Initiative ref survives the terminal cleanup remotely");
    assert.equal(await source.repo.refExists(initiativeRef), true, "the Initiative ref survives the terminal cleanup locally");

    // Repeated synchronization must not touch the Initiative ref: the rule
    // that terminalization never deletes an Initiative is structural and a
    // second sync is the place that rule would silently fail.
    await remote.sync("origin", bare.root, policy(source.store));
    assert.equal(await source.repo.refExists(initiativeRef), true, "a repeated sync never deletes the local Initiative ref");
    assert.equal(await bare.refExists(initiativeRef), true, "a repeated sync never deletes the remote Initiative ref");
  } finally {
    await Promise.all([source.cleanup(), bare.cleanup()]);
  }
});
