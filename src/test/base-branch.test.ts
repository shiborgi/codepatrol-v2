import assert from "node:assert/strict";
import test from "node:test";
import { GitManifestStore } from "../adapters/manifest-store.js";
import { resolveBaseRef } from "../adapters/git-command.js";
import { CodepatrolError } from "../core/errors.js";
import { BRANCH_REF } from "../core/identifiers.js";
import { createTestApp } from "./support/app.js";
import { createBareRemote, createTestRepo } from "./support/repo.js";

test("runs a complete lifecycle on a repository whose base is not main", async () => {
  // Exercise branch resolution end to end rather than only validating a ref.
  const app = await createTestApp({ defaultBranch: "trunk" });
  try {
    const workId = await app.createWork({ title: "Works on trunk" });
    await app.runThrough(workId);

    const view = await app.works.show(workId);
    assert.equal(view.state, "terminal");
    assert.equal(view.outcome, "accepted");
    assert.equal(view.repository.baseRef, "refs/heads/trunk");
    assert.equal(await app.repo.refExists("refs/heads/main"), false);
    // Bootstrap, the manifest projection at branch open, and exactly one squash
    // commit; the Work never wrote its product to the base until it was accepted.
    assert.equal(await app.repo.commitCount("refs/heads/trunk"), 3);
  } finally {
    await app.cleanup();
  }
});

test("prefers the remote default branch over the checked-out one", async () => {
  const repo = await createTestRepo({ defaultBranch: "trunk" });
  const remote = await createBareRemote(repo);
  try {
    await repo.git("push", "origin", "refs/heads/trunk");
    await repo.git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk");
    // Sitting on a side branch must not redefine where Works integrate.
    await repo.git("checkout", "-q", "-b", "side");

    assert.equal(await resolveBaseRef(repo.root), "refs/heads/trunk");
  } finally {
    await remote.cleanup();
    await repo.cleanup();
  }
});

test("falls back to the checked-out branch, then to init.defaultBranch", async () => {
  const repo = await createTestRepo({ defaultBranch: "trunk" });
  try {
    assert.equal(await resolveBaseRef(repo.root), "refs/heads/trunk");

    // Detached HEAD has no branch to offer, so configuration decides.
    await repo.git("config", "init.defaultBranch", "release");
    await repo.git("checkout", "-q", "--detach", "HEAD");
    assert.equal(await resolveBaseRef(repo.root), "refs/heads/release");
  } finally {
    await repo.cleanup();
  }
});

test("honours an explicit base and rejects one that is not a branch ref", async () => {
  const repo = await createTestRepo({ defaultBranch: "trunk" });
  try {
    assert.equal(await resolveBaseRef(repo.root, "refs/heads/release/2026"), "refs/heads/release/2026");
    await assert.rejects(
      resolveBaseRef(repo.root, "trunk"),
      (error: unknown) => error instanceof CodepatrolError && error.code === "INVALID_INPUT",
    );
    await assert.rejects(
      new GitManifestStore(repo.root, { base: "refs/tags/v1" }).baseRef(),
      (error: unknown) => error instanceof CodepatrolError && error.code === "INVALID_INPUT",
    );
  } finally {
    await repo.cleanup();
  }
});

test("validates branch refs without pinning them to a single name", () => {
  for (const ref of ["refs/heads/main", "refs/heads/trunk", "refs/heads/master", "refs/heads/feature/nested", "refs/heads/release-1.2"]) {
    assert.equal(BRANCH_REF.test(ref), true, ref);
  }
  for (const ref of ["main", "refs/heads/", "refs/tags/v1", "refs/heads/a..b", "refs/heads/a b", "refs/heads/x.lock", "refs/heads/trailing/", "refs/heads/trailing."]) {
    assert.equal(BRANCH_REF.test(ref), false, ref);
  }
});

test("records the base each Work integrates into", async () => {
  const app = await createTestApp({ defaultBranch: "trunk" });
  try {
    const workId = await app.createWork({ title: "Base is recorded" });
    // The manifest is the authority on where this Work integrates, so a later
    // change to the repository default cannot silently redirect it.
    assert.equal((await app.store.read(workId)).manifest.repository.baseRef, "refs/heads/trunk");
  } finally {
    await app.cleanup();
  }
});
