import assert from "node:assert/strict";
import test from "node:test";
import { CodepatrolError } from "../core/errors.js";
import { parseVerifyPolicy, unsatisfiedCommands, verifyPolicyHash, VERIFY_POLICY_PATH } from "../core/verify-policy.js";
import type { ManifestTrace } from "../core/work-manifest.js";
import { createTestApp, DONE_TODO, TODO, type TestApp } from "./support/app.js";

const REQUIRED = ["node", "-e", "process.exit(0)"];

function trace(command: string[], exitCode = 0): ManifestTrace {
  return { id: "a1b2c3d4e5f6", type: "command", message: "ran it", command, exitCode, at: "2026-07-31T05:00:00.000Z" };
}

async function appWithPolicy(policy: unknown): Promise<TestApp> {
  return createTestApp({ defaultBranch: "trunk", verifyPolicy: policy });
}

/** Runs a Work up to a live Verify attempt, returning that run. */
async function verifying(app: TestApp): Promise<{ workId: string; runId: string }> {
  const workId = await app.createWork();
  await app.runThrough(workId, "build");
  const started = await app.works.start("verify", workId, "test-harness", "test-model", TODO);
  return { workId, runId: started.runId };
}

async function completeVerify(app: TestApp, workId: string, runId: string): Promise<unknown> {
  return app.works.complete("verify", workId, runId, {
    decision: "continue",
    summary: "verified",
    handoff: "ship it",
    todo: DONE_TODO,
    artifacts: [],
  });
}

test("parses a policy strictly and rejects anything malformed", () => {
  assert.deepEqual(parseVerifyPolicy('{"verify":{"requiredCommands":[["npm","test"]]}}'), { requiredCommands: [["npm", "test"]], persistOutputExcerpt: false });

  for (const raw of ["{}", '{"verify":{}}', '{"verify":{"requiredCommands":[]}}']) {
    assert.throws(() => parseVerifyPolicy(raw), (error: unknown) => error instanceof CodepatrolError && error.code === "VERIFY_POLICY_REQUIRED", raw);
  }

  for (const raw of [
    "not json",
    "[]",
    '{"surprise":1}',
    '{"verify":{"surprise":1}}',
    '{"verify":{"requiredCommands":"npm test"}}',
    '{"verify":{"requiredCommands":[[]]}}',
    '{"verify":{"requiredCommands":[["npm",""]]}}',
    '{"verify":{"requiredCommands":[["npm",2]]}}',
  ]) {
    assert.throws(() => parseVerifyPolicy(raw), (error: unknown) => error instanceof CodepatrolError && error.code === "INVALID_POLICY", raw);
  }
});

test("hashes what the policy says, not how it was written", () => {
  const spaced = parseVerifyPolicy('{\n  "verify": {\n    "requiredCommands": [\n      ["npm", "test"]\n    ]\n  }\n}\n');
  const compact = parseVerifyPolicy('{"verify":{"requiredCommands":[["npm","test"]]}}');
  assert.equal(verifyPolicyHash(spaced), verifyPolicyHash(compact), "reformatting must not invalidate a standing verification");
  assert.notEqual(verifyPolicyHash(compact), verifyPolicyHash(parseVerifyPolicy('{"verify":{"requiredCommands":[["npm","test","--","--ci"]]}}')));
});

test("a required command is satisfied only by an exact successful run", () => {
  const policy = { requiredCommands: [REQUIRED], persistOutputExcerpt: false };
  assert.deepEqual(unsatisfiedCommands(policy, []), [REQUIRED], "no evidence at all");
  assert.deepEqual(unsatisfiedCommands(policy, [trace(REQUIRED, 1)]), [REQUIRED], "a failing run proves nothing");
  assert.deepEqual(unsatisfiedCommands(policy, [trace(["npm", "run", "verify", "--", "--ci"])]), [REQUIRED], "extra arguments are a different command");
  assert.deepEqual(unsatisfiedCommands(policy, [trace(["npm", "run"])]), [REQUIRED], "a prefix is a different command");
  assert.deepEqual(unsatisfiedCommands(policy, [trace(["npm", "test"]), trace(REQUIRED)]), [], "one exact match among others is enough");
});

test("Verify executes every required command and binds the evidence to its candidate", async () => {
  const app = await appWithPolicy({ verify: { requiredCommands: [REQUIRED] } });
  try {
    const { workId, runId } = await verifying(app);
    const verified = await completeVerify(app, workId, runId) as { stage: string; change: { verification: { policyHash: string } | null } };
    assert.equal(verified.stage, "ship");
    assert.equal(
      verified.change.verification?.policyHash,
      verifyPolicyHash({ requiredCommands: [REQUIRED], persistOutputExcerpt: false }),
      "the manifest records which rules this verification was made under",
    );
    const attempt = (await app.works.show(workId)).attempts.find((item) => item.runId === runId);
    const evidence = attempt?.traces?.find((item) => item.type === "command");
    assert.equal(evidence?.data?.source, "codepatrol");
    assert.equal(evidence?.data?.workId, workId);
    assert.equal(evidence?.data?.runId, runId);
    assert.equal(evidence?.data?.candidateCommit, attempt?.verifiedCandidate?.candidateCommit);
    assert.equal(evidence?.data?.policyHash, attempt?.verifiedCandidate?.policyHash);
  } finally {
    await app.cleanup();
  }
});

test("a harness trace cannot replace a failing Codepatrol command", async () => {
  const failing = ["node", "-e", "process.exit(9)"];
  const app = await appWithPolicy({ verify: { requiredCommands: [failing] } });
  try {
    const { workId, runId } = await verifying(app);
    await app.works.trace("verify", workId, runId, { type: "command", message: "claimed success", command: failing, exitCode: 0 });
    await assert.rejects(
      completeVerify(app, workId, runId),
      (error: unknown) => error instanceof CodepatrolError && error.code === "VERIFY_COMMAND_FAILED",
    );
    assert.equal((await app.works.show(workId)).state, "active");
  } finally {
    await app.cleanup();
  }
});

test("a Change cannot weaken the policy it is verified under", async () => {
  const app = await appWithPolicy({ verify: { requiredCommands: [REQUIRED] } });
  try {
    const workId = await app.createWork();
    await app.runThrough(workId, "review");
    const built = await app.works.start("build", workId, "test-harness", "test-model", TODO);
    const worktree = built.worktreeDirectory as string;

    // The builder tries to remove the requirement from its own candidate.
    await app.repo.write(`.codepatrol/runtime/worktrees/${workId}/${VERIFY_POLICY_PATH}`, '{"verify":{"requiredCommands":[]}}\n');
    await app.repo.gitIn(worktree, "add", "-f", VERIFY_POLICY_PATH);
    await app.repo.gitIn(worktree, "commit", "-q", "-m", "relax the policy");

    await assert.rejects(
      app.works.complete("build", workId, built.runId, { decision: "continue", summary: "built", handoff: "verify", todo: DONE_TODO, artifacts: [] }),
      (error: unknown) => error instanceof CodepatrolError && error.code === "RESERVED_PATH",
    );
  } finally {
    await app.cleanup();
  }
});

test("a repository with no policy cannot start Verify", async () => {
  const app = await createTestApp({ defaultBranch: "trunk", verifyPolicy: null });
  try {
    const workId = await app.createWork();
    await app.runThrough(workId, "build");
    await assert.rejects(
      app.works.start("verify", workId, "test-harness", "test-model", TODO),
      (error: unknown) => error instanceof CodepatrolError && error.code === "VERIFY_POLICY_REQUIRED",
    );
  } finally {
    await app.cleanup();
  }
});
