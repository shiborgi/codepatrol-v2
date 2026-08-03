import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { CodepatrolError } from "../core/errors.js";
import { runShippedSuite, runSkillSuite } from "../cli/skill-evaluation.js";
import { listShippedSkills } from "../cli/commands/skill.js";
import { parseSkillSuite, SUITE_SCHEMA_VERSION, SUITE_TYPE, type Assertion, type SkillSuite } from "../core/skill-suite.js";

const shippedSkillsDirectory = path.resolve(fileURLToPath(import.meta.url), "../../../skills");

const LIST_SKILLS_ASSERTION: Assertion = {
  kind: "command",
  argv: ["skill", "list"],
  exitCode: 0,
  stdout: "codepatrol-verify",
};

function fixture(scenarios: SkillSuite["scenarios"]): SkillSuite {
  return {
    schemaVersion: SUITE_SCHEMA_VERSION,
    type: SUITE_TYPE,
    skill: "codepatrol-verify",
    scenarios,
  };
}

function broken(value: unknown, label: string): CodepatrolError {
  try {
    parseSkillSuite(value);
  } catch (error) {
    assert.ok(error instanceof CodepatrolError, `${label}: threw a non-CodepatrolError`);
    assert.equal(error.code, "STATE_CORRUPT", `${label}: expected STATE_CORRUPT`);
    return error;
  }
  assert.fail(`${label}: parseSkillSuite accepted invalid input.`);
}

test("round-trips a valid suite", () => {
  const suite = fixture([{ id: "scenario-a", title: "Scenario A", assertions: [LIST_SKILLS_ASSERTION] }]);
  const round = parseSkillSuite(JSON.parse(JSON.stringify(suite)));
  assert.deepEqual(round, suite);
});

test("refuses unknown and misspelled fields", () => {
  const valid = fixture([{ id: "scenario-a", title: "Scenario A", assertions: [LIST_SKILLS_ASSERTION] }]);
  broken({ ...valid, extra: true }, "extra top-level field");
  broken({ ...valid, skill: "Not-A-Skill" }, "non-slug skill");
  broken({ ...valid, scenarios: "not-an-array" }, "non-array scenarios");
});

test("refuses duplicate scenario ids", () => {
  const scenario = { id: "duplicate", title: "x", assertions: [LIST_SKILLS_ASSERTION] };
  const valid = fixture([scenario]);
  const error = broken({ ...valid, scenarios: [scenario, scenario] }, "duplicate scenario ids");
  assert.match(error.message, /duplicates/);
});

test("refuses non-slug scenario ids", () => {
  for (const id of ["Bad-Id", "1-leading-digit", "-leading-hyphen", ""]) {
    const valid = fixture([{ id, title: "x", assertions: [LIST_SKILLS_ASSERTION] }]);
    broken(valid, `bad scenario id ${id}`);
  }
});

test("refuses unknown assertion kinds", () => {
  const valid = fixture([{ id: "x", title: "x", assertions: [{ kind: "unknown", argv: [] } as unknown as Assertion] }]);
  broken(valid, "unknown assertion kind");
});

test("content-includes passes when the regex matches the resolved skill's SKILL.md", async () => {
  const suite = fixture([{ id: "content-match", title: "Content match", assertions: [{ kind: "content-includes", skill: "codepatrol-verify", pattern: "verificationTarget\\.candidateCommit" }] }]);
  void suite;
  const manifests = await listShippedSkills(shippedSkillsDirectory);
  const outcome = await runSkillSuite(suite, manifests, shippedSkillsDirectory);
  const result = outcome.results[0];
  assert.ok(result);
  assert.equal(result?.status, "passed");
});

test("content-includes fails when the regex does not match the SKILL.md", async () => {
  const suite = fixture([{ id: "content-miss", title: "Content miss", assertions: [{ kind: "content-includes", skill: "codepatrol-verify", pattern: "this-pattern-must-not-appear-anywhere" }] }]);
  void suite;
  const manifests = await listShippedSkills(shippedSkillsDirectory);
  const outcome = await runSkillSuite(suite, manifests, shippedSkillsDirectory);
  const result = outcome.results[0];
  assert.ok(result);
  assert.equal(result?.status, "failed");
  assert.match(result?.detail ?? "", /content-includes/);
});

test("content-excludes fails when the regex matches the SKILL.md", async () => {
  const suite = fixture([{ id: "exclude-match", title: "Exclude match", assertions: [{ kind: "content-excludes", skill: "codepatrol-verify", pattern: "verificationTarget\\.candidateCommit" }] }]);
  void suite;
  const manifests = await listShippedSkills(shippedSkillsDirectory);
  const outcome = await runSkillSuite(suite, manifests, shippedSkillsDirectory);
  const result = outcome.results[0];
  assert.ok(result);
  assert.equal(result?.status, "failed");
  assert.match(result?.detail ?? "", /content-excludes/);
});

test("command assertion passes when the command succeeds with the expected stdout regex", async () => {
  const suite = fixture([{ id: "command-pass", title: "Command pass", assertions: [{ ...LIST_SKILLS_ASSERTION }] }]);
  void suite;
  const manifests = await listShippedSkills(shippedSkillsDirectory);
  const outcome = await runSkillSuite(suite, manifests, shippedSkillsDirectory);
  const result = outcome.results[0];
  assert.ok(result);
  assert.equal(result?.status, "passed");
});

test("command assertion reports failed when the exit code differs", async () => {
  const suite = fixture([{ id: "command-fail", title: "Command fail", assertions: [{ kind: "command", argv: ["skill", "list"], exitCode: 1 }] }]);
  void suite;
  const manifests = await listShippedSkills(shippedSkillsDirectory);
  const outcome = await runSkillSuite(suite, manifests, shippedSkillsDirectory);
  const result = outcome.results[0];
  assert.ok(result);
  assert.equal(result?.status, "failed");
  assert.match(result?.detail ?? "", /exit/);
});

test("a setup that exits non-zero surfaces as error", async () => {
  const suite = fixture([{ id: "bad-setup", title: "Bad setup", assertions: [{ kind: "command", setup: [{ argv: ["bogus-command"], exitCode: 0 }], argv: ["skill", "list"], exitCode: 0 }] }]);
  void suite;
  const manifests = await listShippedSkills(shippedSkillsDirectory);
  const outcome = await runSkillSuite(suite, manifests, shippedSkillsDirectory);
  const result = outcome.results[0];
  assert.ok(result);
  assert.equal(result?.status, "error");
  assert.match(result?.detail ?? "", /setup/);
});

test("the runner leaves the real repository untouched", async () => {
  const before = await readFile(path.resolve(fileURLToPath(import.meta.url), "../../../package.json"), "utf8");
  const suite = fixture([{ id: "real-repo", title: "Real repo", assertions: [{ ...LIST_SKILLS_ASSERTION }] }]);
  void suite;
  const manifests = await listShippedSkills(shippedSkillsDirectory);
  await runSkillSuite(suite, manifests, shippedSkillsDirectory);
  const after = await readFile(path.resolve(fileURLToPath(import.meta.url), "../../../package.json"), "utf8");
  assert.equal(before, after, "the runner must not touch the real repository");
});

test("the deliberately broken expectation makes the runner report failed", async () => {
  const suite = fixture([{ id: "broken", title: "Broken expectation", assertions: [{ kind: "content-includes", skill: "codepatrol-verify", pattern: "STRING_THAT_DOES_NOT_APPEAR_IN_THE_SKILL_FILE" }] }]);
  void suite;
  const manifests = await listShippedSkills(shippedSkillsDirectory);
  const outcome = await runSkillSuite(suite, manifests, shippedSkillsDirectory);
  assert.equal(outcome.summary.failed, 1, "the broken expectation must report failed");
  assert.equal(outcome.summary.passed, 0);
  assert.ok(outcome.results.every((entry) => entry.status === "failed"));
});

test("every shipped suite parses and reports no failure", async () => {
  const { readdir } = await import("node:fs/promises");
  const manifests = await listShippedSkills(shippedSkillsDirectory);
  const entries = await readdir(shippedSkillsDirectory, { withFileTypes: true });
  const stageSkills = entries.filter((entry) => entry.isDirectory() && entry.name.startsWith("codepatrol-") && entry.name !== "codepatrol-spec" && entry.name !== "codepatrol-work").map((entry) => entry.name);
  for (const skillId of stageSkills) {
    // A skill that ships no suite.json is allowed; the runner surfaces
    // STATE_CORRUPT in that case, which the assertion covers separately.
    const suitePath = path.join(shippedSkillsDirectory, skillId, "suite.json");
    const hasSuite = await readFile(suitePath, "utf8").then(() => true, () => false);
    if (!hasSuite) continue;
    const outcome = await runShippedSuite(skillId, manifests);
    assert.equal(outcome.summary.failed, 0, `${skillId} suite has a failing scenario: ${outcome.results.filter((entry) => entry.status === "failed").map((entry) => `${entry.id} ${entry.detail}`).join(", ")}`);
    assert.equal(outcome.summary.errored, 0, `${skillId} suite has an erroring scenario: ${outcome.results.filter((entry) => entry.status === "error").map((entry) => `${entry.id} ${entry.detail}`).join(", ")}`);
  }
});

test("scenario results carry the resolved skill identity and composition digest", async () => {
  const suite = fixture([{ id: "identity", title: "Identity", assertions: [{ ...LIST_SKILLS_ASSERTION }] }]);
  void suite;
  const manifests = await listShippedSkills(shippedSkillsDirectory);
  const skill = manifests.find((manifest) => manifest.id === "codepatrol-verify");
  assert.ok(skill);
  const outcome = await runShippedSuite("codepatrol-verify", manifests);
  const result = outcome.results[0];
  assert.ok(result);
  assert.deepEqual(result?.skill, { id: "codepatrol-verify", version: skill?.version, digest: skill?.digest });
  assert.equal(typeof result?.resolutionDigest, "string");
  assert.match(result?.resolutionDigest ?? "", /^[0-9a-f]{64}$/);
});

test("the runner cleans up its scratch and fixture directories", async () => {
  const { readdir } = await import("node:fs/promises");
  const manifests = await listShippedSkills(shippedSkillsDirectory);
  const before = (await readdir(tmpdir())).filter((entry) => entry.startsWith("codepatrol-eval"));
  await runShippedSuite("codepatrol-verify", manifests);
  const after = (await readdir(tmpdir())).filter((entry) => entry.startsWith("codepatrol-eval"));
  assert.equal(after.length, before.length, "the runner must remove every fixture and scratch directory it creates");
});