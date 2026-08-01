import assert from "node:assert/strict";
import test from "node:test";
import { LocalGitRemote } from "../adapters/local-git-remote.js";
import { GitManifestStore } from "../adapters/manifest-store.js";
import { CodepatrolError } from "../core/errors.js";
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
