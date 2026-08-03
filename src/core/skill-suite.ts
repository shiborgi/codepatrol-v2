import { CodepatrolError } from "./errors.js";
import { SKILL_ID } from "./identifiers.js";

export const SUITE_SCHEMA_VERSION = 1;
export const SUITE_TYPE = "codepatrol-skill-suite";

const SUITE_ID = /^[a-z][a-z0-9-]{0,63}$/;

export type Assertion =
  | {
      kind: "content-includes";
      /** The resolved skill whose SKILL.md is asserted on. */
      skill: string;
      /** Regex that must match the resolved skill's SKILL.md bytes. */
      pattern: string;
    }
  | {
      kind: "content-excludes";
      skill: string;
      /** Regex that must not match the resolved skill's SKILL.md bytes. */
      pattern: string;
    }
  | {
      kind: "command";
      /** `argv` for `node bin/codepatrol.js --workspace <fixture> <argv...>`. */
      argv: string[];
      /** Expected exit code; defaults to 0. */
      exitCode?: number;
      /** Optional regex the stderr must match when the command fails. */
      stderr?: string;
      /** Optional regex the stdout must match. */
      stdout?: string;
      /**
       * Optional setup commands run before the assertion, each with its own
       * exit code expectation. Use for spec apply / work create that needs to
       * succeed before the assertion runs.
       */
      setup?: Array<{ argv: string[]; exitCode?: number }>;
    };

export interface Scenario {
  /** Stable identifier, unique within the suite. Used in result reports. */
  id: string;
  title: string;
  assertions: Assertion[];
}

export interface SkillSuite {
  schemaVersion: typeof SUITE_SCHEMA_VERSION;
  type: typeof SUITE_TYPE;
  /** The skill this suite evaluates; must match the directory name. */
  skill: string;
  scenarios: Scenario[];
}

export type ScenarioStatus = "passed" | "failed" | "error" | "skipped" | "unresolved";

export interface ScenarioResult {
  id: string;
  status: ScenarioStatus;
  detail?: string;
  /** Resolved skill identity captured on every result. */
  skill: { id: string; version: string; digest: string };
  /** Composition digest of the resolved set for this scenario. */
  resolutionDigest: string;
}

function fail(message: string): never {
  throw new CodepatrolError("STATE_CORRUPT", message);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, allowed: readonly string[], required: readonly string[], label: string): void {
  const actual = Object.keys(value);
  if (actual.some((key) => !allowed.includes(key)) || required.some((key) => !actual.includes(key))) fail(`${label} has invalid fields.`);
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") fail(`${label} must be a non-empty string.`);
  return value as string;
}

function textArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) fail(`${label} must be an array.`);
  return value.map((entry, index) => {
    if (typeof entry !== "string") fail(`${label}[${index}] must be a string.`);
    return entry as string;
  });
}

function parseAssertion(value: unknown): Assertion {
  const record = object(value, "Suite assertion");
  const kind = text(record.kind, "Suite assertion kind");
  if (kind === "content-includes" || kind === "content-excludes") {
    const allowed = ["kind", "skill", "pattern"];
    keys(record, allowed, allowed, `Suite assertion ${kind}`);
    const skill = text(record.skill, "Suite assertion skill");
    if (!SKILL_ID.test(skill)) fail(`Suite assertion skill is not a valid skill id: ${skill}.`);
    const pattern = text(record.pattern, "Suite assertion pattern");
    return { kind, skill, pattern };
  }
  if (kind === "command") {
    const allowed = ["kind", "argv", "exitCode", "stderr", "stdout", "setup"];
    keys(record, allowed, ["kind", "argv"], `Suite assertion ${kind}`);
    const argv = textArray(record.argv, "Suite assertion argv");
    if (argv.length === 0) fail("Suite assertion argv must be a non-empty array.");
    const exitCode = record.exitCode === undefined ? 0 : (() => {
      if (typeof record.exitCode !== "number" || !Number.isInteger(record.exitCode)) fail("Suite assertion exitCode must be an integer.");
      return record.exitCode;
    })();
    const stderr = record.stderr === undefined ? undefined : text(record.stderr, "Suite assertion stderr");
    const stdout = record.stdout === undefined ? undefined : text(record.stdout, "Suite assertion stdout");
    const setup = record.setup === undefined ? undefined : (() => {
      if (!Array.isArray(record.setup)) fail("Suite assertion setup must be an array.");
      const parsed: Array<{ argv: string[]; exitCode?: number }> = [];
      for (const [index, entry] of (record.setup as unknown[]).entries()) {
        const setupRecord = object(entry, `Suite assertion setup[${index}]`);
        const setupAllowed = ["argv", "exitCode"];
        keys(setupRecord, setupAllowed, ["argv"], `Suite assertion setup[${index}]`);
        const setupArgv = textArray(setupRecord.argv, `Suite assertion setup[${index}].argv`);
        if (setupRecord.exitCode === undefined) {
          parsed.push({ argv: setupArgv });
          continue;
        }
        if (typeof setupRecord.exitCode !== "number" || !Number.isInteger(setupRecord.exitCode)) {
          fail("Suite assertion setup exitCode must be an integer.");
        }
        parsed.push({ argv: setupArgv, exitCode: setupRecord.exitCode });
      }
      return parsed;
    })();
    const commandAssertion: Assertion & { kind: "command" } = { kind: "command", argv, exitCode };
    if (stderr !== undefined) commandAssertion.stderr = stderr;
    if (stdout !== undefined) commandAssertion.stdout = stdout;
    if (setup !== undefined) commandAssertion.setup = setup;
    return commandAssertion;
  }
  fail(`Suite assertion kind is unsupported: ${kind}.`);
}

export function parseSkillSuite(value: unknown): SkillSuite {
  const record = object(value, "Skill suite");
  const required = ["schemaVersion", "type", "skill", "scenarios"];
  const allowed = [...required, "title"];
  keys(record, allowed, required, "Skill suite");
  if (record.schemaVersion !== SUITE_SCHEMA_VERSION) fail("Skill suite schemaVersion is unsupported.");
  if (record.type !== SUITE_TYPE) fail("Skill suite type is invalid.");
  const skill = text(record.skill, "Skill suite skill");
  if (!SKILL_ID.test(skill)) fail(`Skill suite skill is not a valid skill id: ${skill}.`);
  if (!Array.isArray(record.scenarios)) fail("Skill suite scenarios must be an array.");
  const scenarios: Scenario[] = [];
  const ids = new Set<string>();
  for (const [index, entry] of (record.scenarios as unknown[]).entries()) {
    const scenarioRecord = object(entry, `Skill suite scenarios[${index}]`);
    const scenarioAllowed = ["id", "title", "assertions"];
    keys(scenarioRecord, scenarioAllowed, scenarioAllowed, `Skill suite scenarios[${index}]`);
    const id = text(scenarioRecord.id, `Skill suite scenarios[${index}].id`);
    if (!SUITE_ID.test(id)) fail(`Skill suite scenarios[${index}].id is not a valid scenario id: ${id}.`);
    if (ids.has(id)) fail(`Skill suite scenarios[${index}].id duplicates an earlier scenario: ${id}.`);
    ids.add(id);
    const title = text(scenarioRecord.title, `Skill suite scenarios[${index}].title`);
    if (!Array.isArray(scenarioRecord.assertions)) fail(`Skill suite scenarios[${index}].assertions must be an array.`);
    const assertions: Assertion[] = (scenarioRecord.assertions as unknown[]).map((assertion) => parseAssertion(assertion));
    scenarios.push({ id, title, assertions });
  }
  const suite: SkillSuite = {
    schemaVersion: SUITE_SCHEMA_VERSION,
    type: SUITE_TYPE,
    skill,
    scenarios,
  };
  if (record.title !== undefined && typeof record.title === "string") {
    (suite as { title?: string }).title = record.title;
  }
  return suite;
}