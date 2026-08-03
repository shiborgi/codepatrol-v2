import assert from "node:assert/strict";
import test from "node:test";
import { CodepatrolError } from "../core/errors.js";
import { resolveComposition } from "../core/skill-resolution.js";
import type { SkillManifest } from "../core/skill.js";

const DIGEST_64 = "0".repeat(64);
const DIGEST_64_ALT = "a".repeat(64);

function manifest(id: string, overrides: Partial<SkillManifest> = {}): SkillManifest {
  return {
    schemaVersion: 1,
    type: "codepatrol-skill",
    id,
    version: "1.0.0",
    kind: id.startsWith("codepatrol-") && ["plan", "review", "build", "verify", "ship"].some((s) => id === `codepatrol-${s}`) ? "stage" : "secondary",
    capabilities: ["cli"],
    digest: DIGEST_64,
    ...overrides,
  };
}

test("exactly one stage skill resolves", () => {
  const plan = manifest("codepatrol-plan");
  const work = manifest("codepatrol-work", { kind: "secondary" });
  const composition = resolveComposition("plan", [plan, work], ["cli"]);
  assert.equal(composition.stage, "plan");
  assert.deepEqual(composition.skills.map((s) => s.id), ["codepatrol-plan"]);
  assert.equal(composition.digest.length, 64);
  assert.deepEqual(composition.included, [{ id: "codepatrol-plan", reason: "the stage skill for plan" }]);
  assert.deepEqual(composition.omitted, []);
});

test("zero stage matches refuses with SKILL_UNRESOLVABLE", () => {
  const work = manifest("codepatrol-work", { kind: "secondary" });
  assert.throws(
    () => resolveComposition("plan", [work], ["cli"]),
    (error: unknown) => error instanceof CodepatrolError && error.code === "SKILL_UNRESOLVABLE" && /codepatrol-plan/.test(error.message),
  );
});

test("several stage matches refuse with SKILL_UNRESOLVABLE", () => {
  const a = manifest("codepatrol-plan", { digest: DIGEST_64 });
  const b = manifest("codepatrol-plan", { digest: DIGEST_64_ALT });
  assert.throws(
    () => resolveComposition("plan", [a, b], ["cli"]),
    (error: unknown) => error instanceof CodepatrolError && error.code === "SKILL_UNRESOLVABLE" && /Multiple/.test(error.message),
  );
});

test("required dependencies resolve transitively", () => {
  const plan = manifest("codepatrol-plan", { requires: ["codepatrol-base"] });
  const base = manifest("codepatrol-base", { kind: "secondary", requires: ["codepatrol-leaf"] });
  const leaf = manifest("codepatrol-leaf", { kind: "secondary" });
  const composition = resolveComposition("plan", [plan, base, leaf], ["cli"]);
  assert.deepEqual(composition.skills.map((s) => s.id), ["codepatrol-plan", "codepatrol-base", "codepatrol-leaf"]);
  const reasons = Object.fromEntries(composition.included.map((r) => [r.id, r.reason]));
  assert.equal(reasons["codepatrol-plan"], "the stage skill for plan");
  assert.equal(reasons["codepatrol-base"], "required by codepatrol-plan");
  assert.equal(reasons["codepatrol-leaf"], "required by codepatrol-base");
});

test("a missing required id refuses with SKILL_UNRESOLVABLE", () => {
  const plan = manifest("codepatrol-plan", { requires: ["codepatrol-missing"] });
  assert.throws(
    () => resolveComposition("plan", [plan], ["cli"]),
    (error: unknown) => error instanceof CodepatrolError && error.code === "SKILL_UNRESOLVABLE" && /codepatrol-missing/.test(error.message),
  );
});

test("a self-required id refuses with SKILL_UNRESOLVABLE", () => {
  const plan = manifest("codepatrol-plan", { requires: ["codepatrol-plan"] });
  assert.throws(
    () => resolveComposition("plan", [plan], ["cli"]),
    (error: unknown) => error instanceof CodepatrolError && error.code === "SKILL_UNRESOLVABLE" && /itself/.test(error.message),
  );
});

test("a recommended skill is included with its reason", () => {
  const plan = manifest("codepatrol-plan", { recommends: ["codepatrol-work"] });
  const work = manifest("codepatrol-work", { kind: "secondary" });
  const composition = resolveComposition("plan", [plan, work], ["cli"]);
  assert.deepEqual(composition.skills.map((s) => s.id), ["codepatrol-plan", "codepatrol-work"]);
  const reasons = Object.fromEntries(composition.included.map((r) => [r.id, r.reason]));
  assert.equal(reasons["codepatrol-work"], "recommended by codepatrol-plan");
  assert.deepEqual(composition.omitted, []);
});

test("a recommended skill absent from the manifest set is reported as omitted", () => {
  const plan = manifest("codepatrol-plan", { recommends: ["codepatrol-missing"] });
  const composition = resolveComposition("plan", [plan], ["cli"]);
  assert.deepEqual(composition.skills.map((s) => s.id), ["codepatrol-plan"]);
  assert.deepEqual(composition.omitted, [{ id: "codepatrol-missing", reason: "recommended by codepatrol-plan, not available" }]);
});

test("a declared conflict between included skills refuses with SKILL_CONFLICT", () => {
  const plan = manifest("codepatrol-plan", { requires: ["codepatrol-aux"] });
  const aux = manifest("codepatrol-aux", { kind: "secondary", conflicts: ["codepatrol-plan"] });
  assert.throws(
    () => resolveComposition("plan", [plan, aux], ["cli"]),
    (error: unknown) => error instanceof CodepatrolError && error.code === "SKILL_CONFLICT" && /codepatrol-plan/.test(error.message) && /codepatrol-aux/.test(error.message),
  );
});

test("an unmet capability refuses with SKILL_CAPABILITY_UNMET", () => {
  const plan = manifest("codepatrol-plan", { capabilities: ["cli", "fs"] });
  assert.throws(
    () => resolveComposition("plan", [plan], ["cli"]),
    (error: unknown) => error instanceof CodepatrolError && error.code === "SKILL_CAPABILITY_UNMET" && /fs/.test(error.message),
  );
});

test("same inputs produce the same order and digest; a digest change propagates", () => {
  const planA = manifest("codepatrol-plan", { recommends: ["codepatrol-work"] });
  const workA = manifest("codepatrol-work", { kind: "secondary", digest: DIGEST_64_ALT });
  const planB = manifest("codepatrol-plan", { recommends: ["codepatrol-work"] });
  const workB = manifest("codepatrol-work", { kind: "secondary", digest: DIGEST_64_ALT });
  const left = resolveComposition("plan", [planA, workA], ["cli"]);
  const right = resolveComposition("plan", [planB, workB], ["cli"]);
  assert.equal(left.digest, right.digest, "same inputs give the same digest");

  const workChanged = manifest("codepatrol-work", { kind: "secondary", digest: "b".repeat(64) });
  const withChange = resolveComposition("plan", [planA, workChanged], ["cli"]);
  assert.notEqual(withChange.digest, left.digest, "a changed digest changes the composition digest");
});

test("the composition is stage-first then ascending id", () => {
  const plan = manifest("codepatrol-plan", { recommends: ["codepatrol-aux", "codepatrol-alpha"] });
  const b = manifest("codepatrol-aux", { kind: "secondary" });
  const a = manifest("codepatrol-alpha", { kind: "secondary" });
  const composition = resolveComposition("plan", [plan, b, a], ["cli"]);
  assert.deepEqual(composition.skills.map((s) => s.id), ["codepatrol-plan", "codepatrol-alpha", "codepatrol-aux"]);
});