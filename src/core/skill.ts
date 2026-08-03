import { CodepatrolError } from "./errors.js";
import { SKILL_ID } from "./identifiers.js";
import { sha256 } from "./json.js";

export const SKILL_SCHEMA_VERSION = 1;
export const SKILL_TYPE = "codepatrol-skill";
export const SKILL_KINDS = ["stage", "secondary"] as const;
export type SkillKind = (typeof SKILL_KINDS)[number];

const SKILL_VERSION = /^\d+\.\d+\.\d+$/;
const SKILL_CAPABILITY = /^[a-z0-9][a-z0-9-]*$/;
const SKILL_DIGEST = /^[0-9a-f]{64}$/;

/**
 * A skill's machine-readable identity, declared in `skill.json` beside its
 * SKILL.md: what it is called, which revision of itself it is, what kind of
 * skill it is, what it needs from its host, and the digest that ties the
 * declaration to the skill file's exact bytes.
 *
 * Dependency, recommendation, and conflict declarations are optional under
 * schemaVersion 1: a manifest without them still parses, and a stage that
 * declares none resolves to itself alone. Resolution and dependency evaluation
 * live in src/core/skill-resolution.ts; this module is identity and validation.
 */
export interface SkillManifest {
  schemaVersion: typeof SKILL_SCHEMA_VERSION;
  type: typeof SKILL_TYPE;
  /** The directory name under skills/. */
  id: string;
  version: string;
  kind: SkillKind;
  capabilities: string[];
  /** Lowercase hex SHA-256 of the exact bytes of SKILL.md alone. */
  digest: string;
  /** Skill ids this skill requires. Absent when none. */
  requires?: readonly string[];
  /** Skill ids this skill recommends. Absent when none. */
  recommends?: readonly string[];
  /** Skill ids this skill conflicts with. Absent when none. */
  conflicts?: readonly string[];
}

export function serializeSkillManifest(manifest: SkillManifest): string {
  const ordered = {
    schemaVersion: manifest.schemaVersion,
    type: manifest.type,
    id: manifest.id,
    version: manifest.version,
    kind: manifest.kind,
    capabilities: manifest.capabilities,
    digest: manifest.digest,
    ...(manifest.requires === undefined ? {} : { requires: manifest.requires }),
    ...(manifest.recommends === undefined ? {} : { recommends: manifest.recommends }),
    ...(manifest.conflicts === undefined ? {} : { conflicts: manifest.conflicts }),
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

/** The digest a manifest records: the skill file alone, never the manifest itself. */
export function skillContentDigest(contents: string | Buffer): string {
  return sha256(contents);
}

function corrupt(message: string): never {
  throw new CodepatrolError("STATE_CORRUPT", message);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) corrupt(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, allowed: readonly string[], required: readonly string[], label: string): void {
  const actual = Object.keys(value);
  if (actual.some((key) => !allowed.includes(key)) || required.some((key) => !actual.includes(key))) corrupt(`${label} has invalid fields.`);
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") corrupt(`${label} must be a non-empty string.`);
  return value as string;
}

function skillIdList(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value)) corrupt(`${label} must be an array.`);
  const items = value.map((entry) => {
    if (typeof entry !== "string" || !SKILL_ID.test(entry)) corrupt(`${label} must contain only skill ids.`);
    return entry as string;
  });
  if (new Set(items).size !== items.length) corrupt(`${label} entries must be unique.`);
  return items;
}

export function parseSkillManifest(value: unknown): SkillManifest {
  const record = object(value, "Skill manifest");
  const required = ["schemaVersion", "type", "id", "version", "kind", "capabilities", "digest"];
  const allowed = [...required, "requires", "recommends", "conflicts"];
  keys(record, allowed, required, "Skill manifest");
  if (record.schemaVersion !== SKILL_SCHEMA_VERSION) corrupt("Skill manifest schemaVersion is unsupported.");
  if (record.type !== SKILL_TYPE) corrupt("Skill manifest type is invalid.");
  const id = text(record.id, "Skill manifest id");
  if (!SKILL_ID.test(id)) corrupt("Skill manifest id is invalid.");
  const version = text(record.version, "Skill manifest version");
  if (!SKILL_VERSION.test(version)) corrupt("Skill manifest version is invalid.");
  const kind = text(record.kind, "Skill manifest kind");
  if (!(SKILL_KINDS as readonly string[]).includes(kind)) corrupt("Skill manifest kind is invalid.");
  if (!Array.isArray(record.capabilities)) corrupt("Skill manifest capabilities must be an array.");
  const capabilities = record.capabilities.map((capability) => {
    if (typeof capability !== "string" || !SKILL_CAPABILITY.test(capability)) corrupt("Skill manifest capability is invalid.");
    return capability as string;
  });
  if (new Set(capabilities).size !== capabilities.length) corrupt("Skill manifest capabilities must be unique.");
  const digest = text(record.digest, "Skill manifest digest");
  if (!SKILL_DIGEST.test(digest)) corrupt("Skill manifest digest is invalid.");
  const parsed: SkillManifest = {
    schemaVersion: SKILL_SCHEMA_VERSION,
    type: SKILL_TYPE,
    id,
    version,
    kind: kind as SkillKind,
    capabilities,
    digest,
  };
  if (record.requires !== undefined) parsed.requires = skillIdList(record.requires, "Skill manifest requires");
  if (record.recommends !== undefined) parsed.recommends = skillIdList(record.recommends, "Skill manifest recommends");
  if (record.conflicts !== undefined) parsed.conflicts = skillIdList(record.conflicts, "Skill manifest conflicts");
  return parsed;
}