import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { CodepatrolError } from "../core/errors.js";
import {
  SKILL_KINDS,
  SKILL_SCHEMA_VERSION,
  SKILL_TYPE,
  parseSkillManifest,
  serializeSkillManifest,
  skillContentDigest,
} from "../core/skill.js";
import { listShippedSkills, skillCommand } from "../cli/commands/skill.js";
import type { CommandContext } from "../cli/command.js";
import { STAGES } from "../core/types.js";

const skillsDirectory = path.join(process.cwd(), "skills");

const valid = {
  schemaVersion: SKILL_SCHEMA_VERSION,
  type: SKILL_TYPE,
  id: "codepatrol-example",
  version: "1.0.0",
  kind: "stage",
  capabilities: ["cli"],
  digest: "0".repeat(64),
};

function corruptOf(value: unknown): CodepatrolError {
  try {
    parseSkillManifest(value);
  } catch (error) {
    assert.ok(error instanceof CodepatrolError);
    assert.equal(error.code, "STATE_CORRUPT");
    return error;
  }
  assert.fail("parseSkillManifest accepted an invalid manifest.");
}

test("round-trips a valid manifest", () => {
  const parsed = parseSkillManifest(valid);
  assert.deepEqual(parsed, valid);
  assert.deepEqual(parseSkillManifest(JSON.parse(serializeSkillManifest(parsed))), valid);
});

test("refuses unknown and misspelled fields", () => {
  corruptOf({ ...valid, harness: "none" });
  const misspelled = { ...valid, capability: valid.capabilities } as Record<string, unknown>;
  delete misspelled.capabilities;
  corruptOf(misspelled);
});

test("refuses invalid field values", () => {
  corruptOf({ ...valid, schemaVersion: 2 });
  corruptOf({ ...valid, type: "codepatrol-initiative" });
  corruptOf({ ...valid, id: "Codepatrol-Example" });
  corruptOf({ ...valid, version: "1.0" });
  corruptOf({ ...valid, kind: "primary" });
  corruptOf({ ...valid, digest: "0".repeat(63) });
  corruptOf({ ...valid, digest: "a".repeat(64).toUpperCase() });
  corruptOf({ ...valid, capabilities: ["cli", "cli"] });
  corruptOf({ ...valid, capabilities: ["CLI"] });
});

test("accepts empty capabilities", () => {
  assert.deepEqual(parseSkillManifest({ ...valid, capabilities: [] }).capabilities, []);
});

test("accepts the optional requires, recommends, and conflicts arrays when absent", () => {
  const parsed = parseSkillManifest(valid);
  assert.equal(parsed.requires, undefined);
  assert.equal(parsed.recommends, undefined);
  assert.equal(parsed.conflicts, undefined);
});

test("accepts requires, recommends, and conflicts when present and well-formed", () => {
  const parsed = parseSkillManifest({
    ...valid,
    requires: ["codepatrol-base"],
    recommends: ["codepatrol-work"],
    conflicts: ["codepatrol-other"],
  });
  assert.deepEqual(parsed.requires, ["codepatrol-base"]);
  assert.deepEqual(parsed.recommends, ["codepatrol-work"]);
  assert.deepEqual(parsed.conflicts, ["codepatrol-other"]);
});

test("refuses non-skill-id tokens in requires, recommends, and conflicts", () => {
  corruptOf({ ...valid, requires: ["CamelCase"] });
  corruptOf({ ...valid, recommends: ["Bad Id"] });
  corruptOf({ ...valid, conflicts: ["has space"] });
});

test("refuses duplicate entries within requires, recommends, and conflicts", () => {
  corruptOf({ ...valid, requires: ["codepatrol-x", "codepatrol-x"] });
  corruptOf({ ...valid, recommends: ["codepatrol-x", "codepatrol-x"] });
  corruptOf({ ...valid, conflicts: ["codepatrol-x", "codepatrol-x"] });
});

test("refuses non-array values for requires, recommends, and conflicts", () => {
  corruptOf({ ...valid, requires: "codepatrol-x" });
  corruptOf({ ...valid, recommends: null });
  corruptOf({ ...valid, conflicts: 1 });
});

test("every shipped skill carries a manifest that parses and reproduces", async () => {
  const entries = (await readdir(skillsDirectory, { withFileTypes: true })).filter((entry) => entry.isDirectory());
  assert.ok(entries.length > 0);
  for (const entry of entries) {
    const raw = await readFile(path.join(skillsDirectory, entry.name, "skill.json"), "utf8");
    const manifest = parseSkillManifest(JSON.parse(raw));
    assert.equal(manifest.id, entry.name);
    const skill = await readFile(path.join(skillsDirectory, entry.name, "SKILL.md"));
    assert.equal(manifest.digest, skillContentDigest(skill));
    const expectedKind = STAGES.some((stage) => manifest.id === `codepatrol-${stage}`) ? "stage" : "secondary";
    assert.equal(manifest.kind, expectedKind);
    assert.ok(SKILL_KINDS.includes(manifest.kind));
    // Harness neutrality: the manifest must never name a harness.
    assert.doesNotMatch(raw, /OpenCode|Claude|\bPi\b/i);
  }
});

test("skill list returns the shipped skills sorted by id and changes nothing", async () => {
  const first = await listShippedSkills(skillsDirectory);
  const second = await listShippedSkills(skillsDirectory);
  assert.deepEqual(first, second);
  assert.ok(first.length > 0);
  const ids = first.map((skill) => skill.id);
  assert.deepEqual(ids, [...ids].sort());
  for (const skill of first) {
    assert.match(skill.version, /^\d+\.\d+\.\d+$/);
    assert.match(skill.digest, /^[0-9a-f]{64}$/);
  }
});

function emptyContext(): CommandContext {
  return {
    workspace: ".",
    works: {
      list: async () => [],
      show: async () => assert.fail("unused"),
      graph: async () => assert.fail("unused"),
      start: async () => assert.fail("unused"),
      resume: async () => assert.fail("unused"),
      trace: async () => assert.fail("unused"),
      complete: async () => assert.fail("unused"),
      checkout: async () => assert.fail("unused"),
      inspect: async () => assert.fail("unused"),
      refresh: async () => assert.fail("unused"),
    },
    spec: { inspect: async () => assert.fail("unused"), validate: async () => assert.fail("unused"), apply: async () => assert.fail("unused") },
    initiatives: { list: async () => [], show: async () => assert.fail("unused") },
    publication: { automatic: async () => undefined },
    initialization: { run: async () => assert.fail("unused") },
    doctor: { run: async () => assert.fail("unused") },
  };
}

test("skill resolve <stage> prints the composition with reasons and is idempotent", async () => {
  const first = (await skillCommand.run(emptyContext(), ["resolve", "plan"])) as {
    stage: string;
    skills: { id: string }[];
    included: { id: string; reason: string }[];
    omitted: { id: string; reason: string }[];
  };
  const second = (await skillCommand.run(emptyContext(), ["resolve", "plan"])) as typeof first;
  assert.deepEqual(first, second, "the composition is deterministic");
  assert.equal(first.stage, "plan");
  const ids = first.skills.map((skill) => skill.id);
  assert.ok(ids.includes("codepatrol-plan"));
  // The five stage skills recommend codepatrol-work, so it joins as a secondary.
  assert.ok(ids.includes("codepatrol-work"));
  assert.equal(ids[0], "codepatrol-plan", "the stage skill is first");
  const planReason = first.included.find((item) => item.id === "codepatrol-plan");
  assert.equal(planReason?.reason, "the stage skill for plan");
  const workReason = first.included.find((item) => item.id === "codepatrol-work");
  assert.match(workReason?.reason ?? "", /^recommended by codepatrol-/);
});

test("skill resolve refuses an unknown stage", async () => {
  await assert.rejects(
    skillCommand.run(emptyContext(), ["resolve", "nope"]),
    (error: unknown) => error instanceof CodepatrolError && error.code === "INVALID_ARGUMENT" && /Unknown stage/.test((error as Error).message),
  );
});

test("skill resolve refuses missing and extra positional arguments", async () => {
  await assert.rejects(
    skillCommand.run(emptyContext(), ["resolve"]),
    (error: unknown) => error instanceof CodepatrolError && error.code === "INVALID_ARGUMENT",
  );
  await assert.rejects(
    skillCommand.run(emptyContext(), ["resolve", "plan", "extra"]),
    (error: unknown) => error instanceof CodepatrolError && error.code === "INVALID_ARGUMENT",
  );
});
