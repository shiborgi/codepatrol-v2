import assert from "node:assert/strict";
import test from "node:test";
import { executeGit } from "../adapters/git-command.js";
import { CodepatrolError } from "../core/errors.js";
import { FakeGitHub, ghScript } from "./support/github.js";
import { createBareRemote, createTestRepo } from "./support/repo.js";

test("isolates git from the developer's global and system configuration", async () => {
  const repo = await createTestRepo();
  try {
    // GIT_CONFIG_GLOBAL=/dev/null makes the global scope empty, so a developer's
    // own commit.gpgsign or core.hooksPath cannot reach the suite.
    assert.equal((await repo.tryGit("config", "--global", "--list")).stdout, "");
    // The commit still succeeds, because identity comes from the environment.
    assert.equal(await repo.git("log", "-1", "--format=%an <%ae>"), "Codepatrol Test <codepatrol@example.test>");
    assert.equal(await repo.commitCount("HEAD"), 1);
  } finally {
    await repo.cleanup();
  }
});

test("bootstraps a repository on a branch that is not main", async () => {
  const repo = await createTestRepo({ defaultBranch: "trunk" });
  try {
    assert.equal(await repo.git("symbolic-ref", "--short", "HEAD"), "trunk");
    assert.equal(await repo.refExists("refs/heads/trunk"), true);
    assert.equal(await repo.refExists("refs/heads/main"), false);
  } finally {
    await repo.cleanup();
  }
});

test("reports a failed Git command instead of leaking stdin EPIPE", async () => {
  const repo = await createTestRepo();
  try {
    await assert.rejects(
      executeGit(repo.root, ["not-a-command"], { input: "x".repeat(1024 * 1024) }),
      (error: unknown) => error instanceof CodepatrolError && error.code === "GIT_ERROR" && /not-a-command/.test(error.message),
    );
  } finally {
    await repo.cleanup();
  }
});

test("exposes commit inspection helpers used by protocol assertions", async () => {
  const repo = await createTestRepo();
  try {
    await repo.write("feature.txt", "content\n");
    const commit = await repo.commit("feat: add a feature\n\nCodepatrol-Work: INIT-0.1-example");

    assert.deepEqual(await repo.changedFiles(commit), ["feature.txt"]);
    assert.ok((await repo.messageLines(commit)).includes("Codepatrol-Work: INIT-0.1-example"));
    assert.equal(await repo.showFile("HEAD", "feature.txt"), "content");
    assert.equal(await repo.showFile("HEAD", "absent.txt"), undefined);
    assert.equal(await repo.head(), commit);
  } finally {
    await repo.cleanup();
  }
});

test("installs hooks after bootstrap so they constrain the code under test, not the fixture", async () => {
  const repo = await createTestRepo({ hooks: { "pre-commit": "#!/bin/sh\nexit 1\n" } });
  try {
    // The fixture itself was built before the hook existed.
    assert.equal(await repo.commitCount("HEAD"), 1);
    await repo.write("blocked.txt", "x\n");
    await repo.git("add", "-A");
    assert.equal((await repo.tryGit("commit", "-m", "should fail")).code, 1);
    // Codepatrol's own git calls suppress hooks, which is what the fixture exists to prove.
    assert.equal((await repo.tryGit("-c", "core.hooksPath=/dev/null", "commit", "-m", "bypasses hooks")).code, 0);
    assert.equal(await repo.commitCount("HEAD"), 2);
  } finally {
    await repo.cleanup();
  }
});

test("wires a bare remote for push and fetch assertions", async () => {
  const repo = await createTestRepo();
  const remote = await createBareRemote(repo);
  try {
    await repo.git("push", "origin", `refs/heads/${repo.defaultBranch}`);
    assert.equal(await remote.head(`refs/heads/${repo.defaultBranch}`), await repo.head());
  } finally {
    await remote.cleanup();
    await repo.cleanup();
  }
});

test("records calls and injects one-shot failures on the GitHub fake", async () => {
  const github = new FakeGitHub();
  const issue = github.seedIssue({ number: 7, title: "Import this issue", body: "Issue details" });

  assert.deepEqual(await github.list(), [issue]);
  assert.deepEqual(issue.labels, []);
  const labeled = await github.create("repo", { title: "Typed", body: "body", labels: ["codepatrol:type/feature"] });
  assert.deepEqual(labeled.labels, ["codepatrol:type/feature"]);
  assert.deepEqual((await github.edit("repo", labeled, { addLabels: ["codepatrol:type/bug"], removeLabels: ["codepatrol:type/feature"] })).labels, ["codepatrol:type/bug"]);
  assert.deepEqual((await github.ensureLabel("repo", { name: "codepatrol:type/custom", description: "Custom", color: "00ff00" })).status, "created");
  assert.deepEqual((await github.ensureLabel("repo", { name: "codepatrol:type/custom", description: "Custom", color: "00ff00" })).status, "existing");
  github.failNext("createComment");
  await assert.rejects(github.createComment("repo", 7, "body"));
  const created = await github.createComment("repo", 7, "body");

  assert.equal(created.author, "codepatrol");
  assert.deepEqual(github.commentsFor(7).map((comment) => comment.body), ["body"]);
  assert.ok(github.calls.some((call) => call.op === "list"));
});

test("matches gh argv at the adapter boundary", async () => {
  const run = ghScript([{ match: /^project list/, stdout: JSON.stringify({ projects: [] }) }]);

  assert.equal(await run(["project", "list", "--owner", "acme"]), JSON.stringify({ projects: [] }));
  await assert.rejects(run(["pr", "create"]), /Unexpected gh invocation: pr create/);
});
