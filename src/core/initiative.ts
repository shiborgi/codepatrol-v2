import { CodepatrolError } from "./errors.js";

export const INITIATIVE_SCHEMA_VERSION = 1;
export const INITIATIVE_TYPE = "codepatrol-initiative";
export const INITIATIVE_ID = /^INIT-\d+$/;
/** A full Initiative ref name: the sequential id plus the slug minted from its title. */
export const INITIATIVE_REF_NAME = /^INIT-\d+-[a-z0-9][a-z0-9-]*$/;

export function initiativeRef(id: string, slug: string): string {
  return `refs/codepatrol/initiative/${id}-${slug}`;
}

/** The path the Initiative document occupies inside its ref's commit. */
export function initiativePath(): string {
  return "initiative.json";
}

/**
 * The slug tail of identifiers, minted once from a title and never changed:
 * an identifier that mutates breaks every pointer at it.
 */
export function slugOf(value: string): string {
  const normalized = value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48)
    .replace(/-$/g, "");
  return normalized || "work";
}

/**
 * An Initiative: the declared shape of a set of Works. It records the thinking
 * a flat action list never did — why the demand was split this way, and in which order
 * the pieces should be attacked. Local first: it lives in its own ref and is
 * only projected onto GitHub after the fact.
 */
export interface Initiative {
  schemaVersion: typeof INITIATIVE_SCHEMA_VERSION;
  type: typeof INITIATIVE_TYPE;
  /** `INIT-<n>`, sequential, minted inside the apply transaction. */
  id: string;
  title: string;
  slug: string;
  intent: string;
  /** Why the demand was broken down the way it was. */
  motivation: string;
  /** The rationale for the attack order. */
  ordering: string;
  createdAt: string;
}

export interface InitiativeInput {
  title: string;
  intent: string;
  motivation: string;
  ordering: string;
}

export function serializeInitiative(initiative: Initiative): string {
  const ordered = {
    schemaVersion: initiative.schemaVersion,
    type: initiative.type,
    id: initiative.id,
    title: initiative.title,
    slug: initiative.slug,
    intent: initiative.intent,
    motivation: initiative.motivation,
    ordering: initiative.ordering,
    createdAt: initiative.createdAt,
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
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
  return value;
}

export function parseInitiative(value: unknown): Initiative {
  const record = object(value, "Initiative");
  const fields = ["schemaVersion", "type", "id", "title", "slug", "intent", "motivation", "ordering", "createdAt"];
  keys(record, fields, fields, "Initiative");
  if (record.schemaVersion !== INITIATIVE_SCHEMA_VERSION) corrupt("Initiative schemaVersion is unsupported.");
  if (record.type !== INITIATIVE_TYPE) corrupt("Initiative type is invalid.");
  const id = text(record.id, "Initiative id");
  if (!INITIATIVE_ID.test(id)) corrupt("Initiative id is invalid.");
  const slug = text(record.slug, "Initiative slug");
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) corrupt("Initiative slug is invalid.");
  const createdAt = text(record.createdAt, "Initiative createdAt");
  if (!Number.isFinite(Date.parse(createdAt))) corrupt("Initiative createdAt must be an ISO timestamp.");
  return {
    schemaVersion: INITIATIVE_SCHEMA_VERSION,
    type: INITIATIVE_TYPE,
    id,
    title: text(record.title, "Initiative title"),
    slug,
    intent: text(record.intent, "Initiative intent"),
    motivation: text(record.motivation, "Initiative motivation"),
    ordering: text(record.ordering, "Initiative ordering"),
    createdAt,
  };
}

/** Whether a Work id belongs to an Initiative: `INIT-<n>.<p>-<slug>` names its home. */
export function initiativeOfWork(workId: string): string | undefined {
  const match = /^(INIT-\d+)\./.exec(workId);
  return match?.[1];
}
