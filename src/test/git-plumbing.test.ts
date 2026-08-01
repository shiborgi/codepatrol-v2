import assert from "node:assert/strict";
import test from "node:test";
import { branchCas, commitOnBranch, reconcileWorktreeIndex, squashTree, updateRefsAtomically } from "../adapters/git-plumbing.js";
import { CodepatrolError } from "../core/errors.js";
import { createTestRepo } from "./support/repo.js";

const LEDGER = ".codepatrol/works/INIT-0.1-example/work.json";

test("creates a branch and commits a file with no checkout", async () => {
  const repo = await createTestRepo();
  try {
    const base = await repo.head();
    const result = await commitOnBranch({
      workspace: repo.root,
      branchRef: "refs/heads/codepatrol/work/example",
      parent: base,
      writes: [{ path: LEDGER, contents: "{}\n" }],
      subject: "spec(example): create",
      trailers: ["Codepatrol-Work: INIT-0.1-example"],
    });

    assert.equal(result.changed, true);
    assert.equal(await repo.head("refs/heads/codepatrol/work/example"), result.commit);
    assert.equal(await repo.showFile(result.commit, LEDGER), "{}");
    assert.ok((await repo.messageLines(result.commit)).includes("Codepatrol-Work: INIT-0.1-example"));
    // The base is untouched and no checkout appeared.
    assert.equal(await repo.head(repo.defaultBranch), base);
    assert.equal(await repo.showFile(repo.defaultBranch, LEDGER), undefined);
    assert.equal(await repo.git("status", "--porcelain"), "");
  } finally {
    await repo.cleanup();
  }
});

test("uses an internal identity when Git forbids inferred committers", async () => {
  const repo = await createTestRepo();
  try {
    await repo.git("config", "user.useConfigOnly", "true");
    const result = await commitOnBranch({
      workspace: repo.root,
      branchRef: "refs/heads/codepatrol/work/no-identity",
      parent: await repo.head(),
      writes: [{ path: LEDGER, contents: "{}\n" }],
      subject: "spec(no-identity): create",
    });

    assert.equal(await repo.git("show", "-s", "--format=%an <%ae>", result.commit), "Codepatrol <codepatrol@local.invalid>");
  } finally {
    await repo.cleanup();
  }
});

test("commits a path that .gitignore excludes, without needing add -f", async () => {
  const repo = await createTestRepo({ files: { ".gitignore": ".codepatrol/\n", "README.md": "# Fixture\n" } });
  try {
    const result = await commitOnBranch({
      workspace: repo.root,
      branchRef: "refs/heads/codepatrol/work/ignored",
      parent: await repo.head(),
      writes: [{ path: LEDGER, contents: "{}\n" }],
      subject: "spec(ignored): create",
    });

    assert.equal(await repo.showFile(result.commit, LEDGER), "{}");
  } finally {
    await repo.cleanup();
  }
});

test("skips the commit when the writes change nothing", async () => {
  const repo = await createTestRepo();
  try {
    const first = await commitOnBranch({
      workspace: repo.root,
      branchRef: "refs/heads/codepatrol/work/idempotent",
      parent: await repo.head(),
      writes: [{ path: LEDGER, contents: "{}\n" }],
      subject: "spec: create",
    });
    const second = await commitOnBranch({
      workspace: repo.root,
      branchRef: "refs/heads/codepatrol/work/idempotent",
      parent: first.commit,
      expected: first.commit,
      writes: [{ path: LEDGER, contents: "{}\n" }],
      subject: "spec: no-op",
    });

    assert.equal(second.changed, false);
    assert.equal(second.commit, first.commit);
    assert.equal(await repo.commitCount("refs/heads/codepatrol/work/idempotent"), 2);
  } finally {
    await repo.cleanup();
  }
});

test("a no-op checkpoint still verifies every linked ref", async () => {
  const repo = await createTestRepo();
  try {
    const base = await repo.head();
    const branchRef = "refs/heads/codepatrol/work/idempotent-linked";
    const pointerRef = "refs/codepatrol/manifest/idempotent-linked";
    const created = await commitOnBranch({
      workspace: repo.root,
      branchRef,
      parent: base,
      writes: [{ path: "state.json", contents: "{}\n" }],
      subject: "create",
      linkedRefs: [{ ref: pointerRef }],
    });
    await repo.git("update-ref", pointerRef, base, created.commit);
    await assert.rejects(
      commitOnBranch({
        workspace: repo.root,
        branchRef,
        parent: created.commit,
        expected: created.commit,
        writes: [{ path: "state.json", contents: "{}\n" }],
        subject: "no-op",
        linkedRefs: [{ ref: pointerRef, expected: created.commit }],
      }),
      (error: unknown) => error instanceof CodepatrolError && error.code === "STATE_CONFLICT",
    );
  } finally {
    await repo.cleanup();
  }
});

test("refuses to advance a branch that moved since it was read", async () => {
  const repo = await createTestRepo();
  try {
    const base = await repo.head();
    const first = await commitOnBranch({
      workspace: repo.root,
      branchRef: "refs/heads/codepatrol/work/raced",
      parent: base,
      writes: [{ path: LEDGER, contents: "{\"revision\":1}\n" }],
      subject: "spec: create",
    });
    // Someone else advances the branch between our read and our write.
    await commitOnBranch({
      workspace: repo.root,
      branchRef: "refs/heads/codepatrol/work/raced",
      parent: first.commit,
      expected: first.commit,
      writes: [{ path: LEDGER, contents: "{\"revision\":2}\n" }],
      subject: "spec: concurrent",
    });

    await assert.rejects(
      commitOnBranch({
        workspace: repo.root,
        branchRef: "refs/heads/codepatrol/work/raced",
        parent: first.commit,
        expected: first.commit,
        writes: [{ path: LEDGER, contents: "{\"revision\":3}\n" }],
        subject: "spec: stale",
      }),
      (error: unknown) => error instanceof CodepatrolError && error.code === "STATE_CONFLICT",
    );
  } finally {
    await repo.cleanup();
  }
});

test("refuses to create a branch that already exists", async () => {
  const repo = await createTestRepo();
  try {
    await assert.rejects(
      branchCas(repo.root, `refs/heads/${repo.defaultBranch}`, await repo.head()),
      (error: unknown) => error instanceof CodepatrolError && error.code === "STATE_CONFLICT",
    );
  } finally {
    await repo.cleanup();
  }
});

test("leaves a dirty worktree byte-identical while realigning its index", async () => {
  const repo = await createTestRepo();
  try {
    const base = await repo.head();
    await repo.git("worktree", "add", "-q", "-b", "codepatrol/work/live", ".codepatrol/runtime/worktrees/live", base);
    const worktree = `${repo.root}/.codepatrol/runtime/worktrees/live`;

    // A builder has both staged and unstaged work in flight.
    await repo.write(".codepatrol/runtime/worktrees/live/staged.txt", "staged\n");
    await repo.write(".codepatrol/runtime/worktrees/live/unstaged.txt", "unstaged\n");
    await repo.gitIn(worktree, "add", "staged.txt");

    const manifest = { path: LEDGER, contents: "{\"revision\":1}\n" };
    const committed = await commitOnBranch({
      workspace: repo.root,
      branchRef: "refs/heads/codepatrol/work/live",
      parent: base,
      expected: base,
      writes: [manifest],
      subject: "plan: start",
    });
    await reconcileWorktreeIndex(repo.root, worktree, [manifest]);

    // The manifest reads clean, and the builder's work is exactly as it was.
    assert.equal(await repo.gitIn(worktree, "status", "--porcelain", "--", LEDGER), "");
    assert.equal(await repo.gitIn(worktree, "rev-parse", "HEAD"), committed.commit);
    const status = (await repo.gitIn(worktree, "status", "--porcelain")).split("\n").sort();
    assert.deepEqual(status, ["?? unstaged.txt", "A  staged.txt"]);
    assert.equal(await repo.read(".codepatrol/runtime/worktrees/live/staged.txt"), "staged\n");
    assert.equal(await repo.read(".codepatrol/runtime/worktrees/live/unstaged.txt"), "unstaged\n");
  } finally {
    await repo.cleanup();
  }
});

test("computes a squash tree without touching any checkout", async () => {
  const repo = await createTestRepo();
  try {
    const base = await repo.head();
    await repo.git("worktree", "add", "-q", "-b", "feature", ".work", base);
    const worktree = `${repo.root}/.work`;
    await repo.write(".work/feature.txt", "one\n");
    await repo.gitIn(worktree, "add", "feature.txt");
    await repo.gitIn(worktree, "commit", "-q", "-m", "first");
    await repo.write(".work/feature.txt", "one\ntwo\n");
    await repo.gitIn(worktree, "commit", "-q", "-am", "second");

    // The operator is sitting on a dirty base checkout; squashing must not care.
    await repo.write("scratch.txt", "uncommitted\n");
    const outcome = await squashTree(repo.root, `refs/heads/${repo.defaultBranch}`, "refs/heads/feature");

    assert.equal(outcome.conflicted, false);
    if (outcome.conflicted) return;
    assert.match(outcome.tree, /^[0-9a-f]{40,64}$/);
    assert.equal(await repo.git("cat-file", "-p", `${outcome.tree}:feature.txt`), "one\ntwo");
    assert.equal(await repo.head(repo.defaultBranch), base);
    assert.equal(await repo.read("scratch.txt"), "uncommitted\n");
  } finally {
    await repo.cleanup();
  }
});

test("reports conflicting paths instead of mutating anything", async () => {
  const repo = await createTestRepo();
  try {
    await repo.write("shared.txt", "base\n");
    await repo.commit("add shared");
    const forked = await repo.head();

    await repo.git("worktree", "add", "-q", "-b", "feature", ".work", forked);
    await repo.write(".work/shared.txt", "feature side\n");
    await repo.gitIn(`${repo.root}/.work`, "commit", "-q", "-am", "feature edit");

    await repo.write("shared.txt", "base side\n");
    const diverged = await repo.commit("base edit");

    const outcome = await squashTree(repo.root, `refs/heads/${repo.defaultBranch}`, "refs/heads/feature");

    assert.equal(outcome.conflicted, true);
    if (!outcome.conflicted) return;
    assert.deepEqual(outcome.paths, ["shared.txt"]);
    assert.equal(await repo.head(repo.defaultBranch), diverged);
    assert.equal(await repo.git("status", "--porcelain"), "");
  } finally {
    await repo.cleanup();
  }
});

test("a batch of ref updates moves every ref or none", async () => {
  const repo = await createTestRepo({ defaultBranch: "trunk" });
  try {
    const base = await repo.head("refs/heads/trunk");
    await branchCas(repo.root, "refs/heads/one", base);
    await branchCas(repo.root, "refs/heads/two", base);
    const advanced = await commitOnBranch({
      workspace: repo.root,
      branchRef: "refs/heads/one",
      parent: base,
      expected: base,
      writes: [{ path: "a.txt", contents: "one\n" }],
      subject: "spec: advance",
    });

    // The second update expects a value the ref does not hold, so the whole
    // transaction must be refused rather than leaving the first one applied.
    await assert.rejects(
      updateRefsAtomically(repo.root, [
        { ref: "refs/heads/two", next: advanced.commit, expected: base },
        { ref: "refs/heads/one", next: advanced.commit, expected: base },
      ]),
      (error: unknown) => error instanceof CodepatrolError && error.code === "STATE_CONFLICT",
    );
    assert.equal(await repo.head("refs/heads/two"), base, "the valid half of the batch did not land");

    await updateRefsAtomically(repo.root, [
      { ref: "refs/heads/two", next: advanced.commit, expected: base },
      { ref: "refs/heads/one", next: null, expected: advanced.commit },
    ]);
    assert.equal(await repo.head("refs/heads/two"), advanced.commit);
    assert.equal(await repo.refExists("refs/heads/one"), false, "a delete rides in the same transaction");
  } finally {
    await repo.cleanup();
  }
});
