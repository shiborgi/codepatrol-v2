import assert from "node:assert/strict";
import test from "node:test";
import { CodepatrolError, type ErrorRecovery } from "../core/errors.js";
import { createTestApp, DONE_TODO, TODO } from "./support/app.js";

/**
 * A refused command has usually already committed something. These tests assert
 * that each refusal says what was expected, what was found, which local facts
 * survived, and one safe command — so recovery never requires guessing.
 */
function recoveryOf(error: unknown): ErrorRecovery {
  assert.ok(error instanceof CodepatrolError, "expected a CodepatrolError");
  assert.ok(error.recovery !== undefined, `${error.code} carries no recovery`);
  const recovery = error.recovery;
  assert.ok(recovery.expected !== undefined && recovery.expected !== "", `${error.code} does not say what it expected`);
  assert.ok(recovery.observed !== undefined && recovery.observed !== "", `${error.code} does not say what it observed`);
  assert.ok((recovery.committed ?? []).length > 0, `${error.code} does not say what survived`);
  assert.match(recovery.nextCommand ?? "", /^codepatrol /, `${error.code} does not name a safe next command`);
  return recovery;
}

async function captured(operation: Promise<unknown>): Promise<CodepatrolError> {
  try {
    await operation;
  } catch (error) {
    assert.ok(error instanceof CodepatrolError);
    return error;
  }
  return assert.fail("the operation was expected to fail");
}

test("a blocked Build points at the blocker holding it up", async () => {
  const app = await createTestApp({ defaultBranch: "trunk" });
  try {
    const blocker = await app.createWork({ title: "Foundation" });
    const dependent = await app.createWork({ type: "Feature", title: "Dependent", blockedBy: [blocker] });
    await app.runThrough(dependent, "review");

    const error = await captured(app.works.start("build", dependent, "h", "m", TODO));
    const recovery = recoveryOf(error);
    assert.equal(error.code, "WORK_BLOCKED");
    assert.equal(recovery.nextCommand, `codepatrol work show ${blocker}`);
    assert.match(recovery.committed?.[0] ?? "", /nothing was started/);
  } finally {
    await app.cleanup();
  }
});

test("a Ship refused for a moved base says the decision is not lost", async () => {
  const app = await createTestApp({ defaultBranch: "trunk" });
  try {
    const workId = await app.createWork();
    await app.runThrough(workId, "verify");
    // The base moves after the candidate was verified.
    await app.repo.write("unrelated.txt", "moved on\n");
    await app.repo.commit("advance the base");
    const started = await app.works.start("ship", workId, "h", "m", TODO);

    const error = await captured(app.works.complete("ship", workId, started.runId, {
      decision: "accept", summary: "ship", handoff: "terminal", todo: DONE_TODO, artifacts: [], authority: "release-owner",
    }));
    const recovery = recoveryOf(error);
    assert.equal(error.code, "VERIFY_STALE");
    assert.equal(recovery.nextCommand, `codepatrol change refresh ${workId}`);
    assert.match(recovery.committed?.join(" ") ?? "", /the base was not moved/);
  } finally {
    await app.cleanup();
  }
});

test("a stale document says to inspect again rather than to edit the digest", async () => {
  const app = await createTestApp({ defaultBranch: "trunk" });
  try {
    const inspection = await app.spec.inspect();
    await app.createWork({ title: "Something else entirely" });

    const error = await captured(app.spec.apply({
      schemaVersion: 1,
      type: "codepatrol-initiative-document",
      documentId: "document-stale",
      summary: "written against an older graph",
      observedState: "empty backlog",
      digest: inspection.digest,
      createdAt: "2026-07-31T05:00:00.000Z",
      works: [{ key: "one", title: "First", description: "d", issueType: "Task", priority: "p2", acceptance: ["It works"], blockedBy: [] }],
      cancel: [],
      supersede: [],
      followUp: [],
    }));
    const recovery = recoveryOf(error);
    assert.equal(error.code, "DOCUMENT_REJECTED");
    assert.equal(recovery.nextCommand, "codepatrol spec inspect");
    assert.match(recovery.committed?.join(" ") ?? "", /the Work graph is unchanged/);
  } finally {
    await app.cleanup();
  }
});
