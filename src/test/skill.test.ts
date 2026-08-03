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
import { listShippedSkills } from "../cli/commands/skill.js";
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
