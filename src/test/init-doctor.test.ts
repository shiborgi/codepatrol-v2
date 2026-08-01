import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { DoctorService } from "../application/doctor-service.js";
import { InitService } from "../application/init-service.js";
import { CodepatrolError } from "../core/errors.js";
import { parseRepositoryConfig, REPOSITORY_CONFIG_PATH } from "../core/repository-config.js";
import { parseVerifyPolicy, VERIFY_POLICY_PATH } from "../core/verify-policy.js";
import { createTestRepo } from "./support/repo.js";

const COMMANDS = [["node", "-e", "process.exit(0)"]];

test("initializes a local repository idempotently without GitHub", async () => {
  const repo = await createTestRepo({ defaultBranch: "trunk", verifyPolicy: null });
  try {
    const service = new InitService(repo.root);
    const first = await service.run({ harness: "none", requiredCommands: COMMANDS, github: false, project: { mode: "disabled" }, replace: false });
    assert.equal(first.status, "initialized");
    assert.equal(first.baseBranch, "trunk");
    assert.equal(parseRepositoryConfig(await repo.read(REPOSITORY_CONFIG_PATH)).github.project.mode, "disabled");
    assert.deepEqual(parseVerifyPolicy(await repo.read(VERIFY_POLICY_PATH)).requiredCommands, COMMANDS);
    const second = await service.run({ harness: "none", requiredCommands: COMMANDS, github: false, project: { mode: "disabled" }, replace: false });
    assert.equal(second.status, "unchanged");
  } finally {
    await repo.cleanup();
  }
});

test("preserves existing configuration unless replacement is explicit", async () => {
  const repo = await createTestRepo({ verifyPolicy: null });
  try {
    const service = new InitService(repo.root);
    await service.run({ harness: "none", requiredCommands: COMMANDS, github: false, project: { mode: "disabled" }, replace: false });
    await repo.write(REPOSITORY_CONFIG_PATH, "{}\n");
    await assert.rejects(
      service.run({ harness: "none", requiredCommands: COMMANDS, github: false, project: { mode: "disabled" }, replace: false }),
      (error: unknown) => error instanceof CodepatrolError && error.code === "INIT_CONFLICT",
    );
    const replaced = await service.run({ harness: "none", requiredCommands: COMMANDS, github: false, project: { mode: "disabled" }, replace: true });
    assert.ok(replaced.files.some((file) => file.path === REPOSITORY_CONFIG_PATH && file.action === "replaced"));
  } finally {
    await repo.cleanup();
  }
});

test("installs the selected harness adapter and Spec skill", async () => {
  const repo = await createTestRepo({ verifyPolicy: null });
  try {
    await new InitService(repo.root).run({ harness: "opencode", requiredCommands: COMMANDS, github: false, project: { mode: "disabled" }, replace: false });
    assert.match(await readFile(path.join(repo.root, ".opencode/commands/codepatrol-spec.md"), "utf8"), /codepatrol-spec/);
    assert.match(await readFile(path.join(repo.root, ".opencode/skills/codepatrol-spec/SKILL.md"), "utf8"), /Spec/);
  } finally {
    await repo.cleanup();
  }
});

test("doctor reports local readiness and actionable policy failures", async () => {
  const repo = await createTestRepo({ verifyPolicy: null });
  try {
    await new InitService(repo.root).run({ harness: "none", requiredCommands: COMMANDS, github: false, project: { mode: "disabled" }, replace: false });
    const ready = await new DoctorService(repo.root).run();
    assert.equal(ready.status, "ready");
    assert.equal(ready.checks.find((check) => check.id === "github-cli")?.status, "skipped");
    assert.equal(ready.checks.find((check) => check.id === "github-issue-labels")?.status, "skipped");
    await repo.write(VERIFY_POLICY_PATH, '{"verify":{"requiredCommands":[]}}\n');
    const failed = await new DoctorService(repo.root).run();
    assert.equal(failed.status, "failed");
    const policy = failed.checks.find((check) => check.id === "verify-policy");
    assert.equal(policy?.status, "failed");
    assert.ok(policy?.next);
  } finally {
    await repo.cleanup();
  }
});
