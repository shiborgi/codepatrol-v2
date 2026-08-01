import assert from "node:assert/strict";
import { hostname } from "node:os";
import test from "node:test";
import { withGitRefLock } from "../adapters/git-lock.js";
import { CodepatrolError } from "../core/errors.js";
import { createTestRepo } from "./support/repo.js";

const WORK = "work/INIT-0.1-example";

test("holds the lock as a git ref and releases it afterwards", async () => {
  const repo = await createTestRepo();
  try {
    let observed = "";
    await withGitRefLock(repo.root, "repository", async () => {
      observed = await repo.git("rev-parse", "--verify", "refs/codepatrol/locks/repository");
    });

    assert.match(observed, /^[0-9a-f]{40,64}$/);
    assert.equal(await repo.refExists("refs/codepatrol/locks/repository"), false);
  } finally {
    await repo.cleanup();
  }
});

test("re-entering a held lock passes through instead of failing", async () => {
  const repo = await createTestRepo();
  try {
    // An operation that legitimately nests can call the locked helper directly,
    // rather than keeping a second lock-free copy of it.
    const result = await withGitRefLock(repo.root, WORK, async () =>
      withGitRefLock(repo.root, WORK, async () => "inner ran"),
    );
    assert.equal(result, "inner ran");
    assert.equal(await repo.refExists(`refs/codepatrol/locks/${WORK}`), false);
  } finally {
    await repo.cleanup();
  }
});

test("allows nesting that descends the lock order", async () => {
  const repo = await createTestRepo();
  try {
    const order: string[] = [];
    await withGitRefLock(repo.root, "sync", async () => {
      order.push("sync");
      await withGitRefLock(repo.root, WORK, async () => {
        order.push("work");
        await withGitRefLock(repo.root, "repository", async () => {
          order.push("repository");
        });
      });
    });

    assert.deepEqual(order, ["sync", "work", "repository"]);
  } finally {
    await repo.cleanup();
  }
});

test("refuses nesting that inverts the lock order", async () => {
  const repo = await createTestRepo();
  try {
    // Holding `repository` while waiting for `work/<id>` is the shape that
    // deadlocks two processes against each other.
    await assert.rejects(
      withGitRefLock(repo.root, "repository", async () => withGitRefLock(repo.root, WORK, async () => undefined)),
      (error: unknown) => error instanceof CodepatrolError && error.code === "LOCK_ORDER",
    );
    await assert.rejects(
      withGitRefLock(repo.root, WORK, async () => withGitRefLock(repo.root, "sync", async () => undefined)),
      (error: unknown) => error instanceof CodepatrolError && error.code === "LOCK_ORDER",
    );
    // Two different Works at the same rank deadlock just as easily.
    await assert.rejects(
      withGitRefLock(repo.root, WORK, async () => withGitRefLock(repo.root, "work/INIT-0.2-other", async () => undefined)),
      (error: unknown) => error instanceof CodepatrolError && error.code === "LOCK_ORDER",
    );
  } finally {
    await repo.cleanup();
  }
});

test("releases the lock when the operation throws", async () => {
  const repo = await createTestRepo();
  try {
    await assert.rejects(withGitRefLock(repo.root, "repository", async () => {
      throw new CodepatrolError("GIT_ERROR", "boom");
    }));
    assert.equal(await repo.refExists("refs/codepatrol/locks/repository"), false);
  } finally {
    await repo.cleanup();
  }
});

test("reclaims a lock whose owning process is gone", async () => {
  const repo = await createTestRepo();
  try {
    // A dead same-host owner is detectable by PID, so the lock is recoverable
    // immediately rather than after the staleness window.
    await repo.write(".stale-owner", JSON.stringify({ token: "abandoned", pid: 2 ** 22, hostname: hostname(), createdAt: new Date().toISOString() }));
    const hash = await repo.git("hash-object", "-w", "--", ".stale-owner");
    await repo.git("update-ref", "refs/codepatrol/locks/repository", hash);

    assert.equal(await withGitRefLock(repo.root, "repository", async () => "acquired"), "acquired");
  } finally {
    await repo.cleanup();
  }
});

test("rejects an unknown lock key rather than ranking it silently", async () => {
  const repo = await createTestRepo();
  try {
    await assert.rejects(
      withGitRefLock(repo.root, "mystery", async () => undefined),
      (error: unknown) => error instanceof CodepatrolError && error.code === "INVALID_INPUT",
    );
  } finally {
    await repo.cleanup();
  }
});
