import { CodepatrolError } from "./errors.js";
import { WORK_ID } from "./identifiers.js";
import { ISSUE_TYPES, WORK_PRIORITIES, type IssueType, type WorkPriority } from "./types.js";

export const INITIATIVE_DOCUMENT_SCHEMA_VERSION = 1;
export const INITIATIVE_DOCUMENT_TYPE = "codepatrol-initiative-document";
/** A local handle for a Work the document creates; never survives application. */
export const DOCUMENT_KEY = /^[a-z][a-z0-9-]{0,47}$/;

export type WorkRef =
  | { kind: "id"; id: string }
  | { kind: "key"; key: string };

/**
 * A Work as the document declares it: either new (`key`) or existing (`id`),
 * never both. Everything else is the shape the Work should have after the
 * apply; the Core diffs it against the graph and applies the difference.
 */
export interface DocumentWork {
  key?: string;
  id?: string;
  title: string;
  description: string;
  issueType: IssueType;
  priority: WorkPriority;
  acceptance: string[];
  blockedBy: WorkRef[];
  requestedBy?: string;
}

export interface DocumentFollowUp extends DocumentWork {
  from: string;
}

export interface DocumentCancel {
  workId: string;
  reason: string;
  authority: string;
}

export interface DocumentSupersede {
  workId: string;
  replacedBy: WorkRef[];
  rationale: string;
  authority: string;
}

export interface InitiativeDeclaration {
  title: string;
  intent: string;
  motivation: string;
  ordering: string;
}

/**
 * The declarative shape of an Initiative. One document, diffed against the
 * current graph, applied atomically. Creating, updating, and rewiring are what
 * the diff computes; only what destroys standing Work stays explicit — cancel,
 * supersede, and follow-up — and each of those requires authority.
 */
export interface InitiativeDocument {
  schemaVersion: typeof INITIATIVE_DOCUMENT_SCHEMA_VERSION;
  type: typeof INITIATIVE_DOCUMENT_TYPE;
  documentId: string;
  summary: string;
  /** What the author observed, in prose. Never a second source of truth. */
  observedState: string;
  /** `graphDigest` of the Work graph the document was written against. */
  digest: string;
  createdAt: string;
  intent?: string;
  /** Declares a new Initiative to mint; absent means the latest existing one. */
  initiative?: InitiativeDeclaration;
  works: DocumentWork[];
  cancel: DocumentCancel[];
  supersede: DocumentSupersede[];
  followUp: DocumentFollowUp[];
}

function fail(message: string): never {
  throw new CodepatrolError("INVALID_DOCUMENT", message);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, allowed: readonly string[], required: readonly string[], label: string): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown !== undefined) fail(`${label} has an unknown field: ${unknown}.`);
  const missing = required.find((key) => value[key] === undefined);
  if (missing !== undefined) fail(`${label} is missing ${missing}.`);
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") fail(`${label} must be a non-empty string.`);
  return value;
}

function workId(value: unknown, label: string): string {
  const id = text(value, label);
  if (!WORK_ID.test(id)) fail(`${label} is not a Work id: ${id}.`);
  return id;
}

function documentKey(value: unknown, label: string): string {
  const key = text(value, label);
  if (!DOCUMENT_KEY.test(key)) fail(`${label} must match ${DOCUMENT_KEY}: ${key}.`);
  return key;
}

function workRef(value: unknown, label: string): WorkRef {
  const raw = text(value, label);
  if (raw.startsWith("#")) return { kind: "key", key: documentKey(raw.slice(1), label) };
  return { kind: "id", id: workId(raw, label) };
}

function criteria(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0) fail(`${label} must be a non-empty array.`);
  return value.map((item, index) => text(item, `${label}[${index}]`));
}

function priorityOf(value: unknown, label: string): WorkPriority {
  if (typeof value !== "string" || !WORK_PRIORITIES.includes(value as WorkPriority)) fail(`${label} must be one of: ${WORK_PRIORITIES.join(", ")}.`);
  return value as WorkPriority;
}

function issueTypeOf(value: unknown, label: string): IssueType {
  if (typeof value !== "string" || !ISSUE_TYPES.includes(value as IssueType)) fail(`${label} must be one of: ${ISSUE_TYPES.join(", ")}.`);
  return value as IssueType;
}

const WORK_FIELDS = ["key", "id", "title", "description", "issueType", "priority", "acceptance", "blockedBy", "requestedBy"] as const;

function parseWork(value: unknown, label: string, followUp: boolean): DocumentWork {
  const raw = object(value, label);
  keys(raw, [...WORK_FIELDS, ...(followUp ? ["from"] : [])], ["title", "description", "issueType", "priority", "acceptance", ...(followUp ? ["from"] : [])], label);
  if (raw.key !== undefined && raw.id !== undefined) fail(`${label} cannot carry both key and id.`);
  if (raw.key === undefined && raw.id === undefined) fail(`${label} must carry key (new Work) or id (existing Work).`);
  const blockedBy = raw.blockedBy === undefined ? [] : (raw.blockedBy as unknown[]).map((item, index) => workRef(item, `${label}.blockedBy[${index}]`));
  return {
    ...(raw.key === undefined ? {} : { key: documentKey(raw.key, `${label}.key`) }),
    ...(raw.id === undefined ? {} : { id: workId(raw.id, `${label}.id`) }),
    title: text(raw.title, `${label}.title`),
    description: text(raw.description, `${label}.description`),
    issueType: issueTypeOf(raw.issueType, `${label}.issueType`),
    priority: priorityOf(raw.priority, `${label}.priority`),
    acceptance: criteria(raw.acceptance, `${label}.acceptance`),
    blockedBy,
    ...(raw.requestedBy === undefined ? {} : { requestedBy: text(raw.requestedBy, `${label}.requestedBy`) }),
    ...(followUp ? { from: workId(raw.from, `${label}.from`) } : {}),
  };
}

/**
 * Parses an Initiative document with the same strictness as the manifest:
 * unknown fields are refused rather than dropped, because a misspelled key
 * means the author asked for something other than what they believe they
 * asked for.
 */
export function parseInitiativeDocument(value: unknown): InitiativeDocument {
  const record = object(value, "The document");
  const fields = ["schemaVersion", "type", "documentId", "summary", "observedState", "digest", "createdAt", "intent", "initiative", "works", "cancel", "supersede", "followUp"];
  keys(record, fields, ["schemaVersion", "type", "documentId", "summary", "observedState", "digest", "createdAt", "works"], "The document");
  if (record.schemaVersion !== INITIATIVE_DOCUMENT_SCHEMA_VERSION) fail("The document schemaVersion is unsupported.");
  if (record.type !== INITIATIVE_DOCUMENT_TYPE) fail("The document type is invalid.");
  const createdAt = text(record.createdAt, "The document createdAt");
  if (!Number.isFinite(Date.parse(createdAt))) fail("The document createdAt must be an ISO timestamp.");
  const digest = text(record.digest, "The document digest");
  if (!/^[0-9a-f]{64}$/.test(digest)) fail("The document digest must be a SHA-256 hex digest.");
  const works = (record.works as unknown[]).map((raw, index) => parseWork(raw, `The document works[${index}]`, false));
  const cancel = record.cancel === undefined ? [] : (record.cancel as unknown[]).map((raw, index) => {
    const item = object(raw, `The document cancel[${index}]`);
    keys(item, ["workId", "reason", "authority"], ["workId", "reason", "authority"], `The document cancel[${index}]`);
    return {
      workId: workId(item.workId, `The document cancel[${index}].workId`),
      reason: text(item.reason, `The document cancel[${index}].reason`),
      authority: text(item.authority, `The document cancel[${index}].authority`),
    };
  });
  const supersede = record.supersede === undefined ? [] : (record.supersede as unknown[]).map((raw, index) => {
    const item = object(raw, `The document supersede[${index}]`);
    keys(item, ["workId", "replacedBy", "rationale", "authority"], ["workId", "replacedBy", "rationale", "authority"], `The document supersede[${index}]`);
    const replacedBy = (item.replacedBy as unknown[]).map((ref, refIndex) => workRef(ref, `The document supersede[${index}].replacedBy[${refIndex}]`));
    if (replacedBy.length === 0) fail(`The document supersede[${index}].replacedBy must not be empty.`);
    return {
      workId: workId(item.workId, `The document supersede[${index}].workId`),
      replacedBy,
      rationale: text(item.rationale, `The document supersede[${index}].rationale`),
      authority: text(item.authority, `The document supersede[${index}].authority`),
    };
  });
  const followUp = record.followUp === undefined ? [] : (record.followUp as unknown[]).map((raw, index) => parseWork(raw, `The document followUp[${index}]`, true) as DocumentFollowUp);

  let initiative: InitiativeDeclaration | undefined;
  if (record.initiative !== undefined) {
    const declaration = object(record.initiative, "The document initiative");
    const initiativeFields = ["title", "intent", "motivation", "ordering"];
    keys(declaration, initiativeFields, initiativeFields, "The document initiative");
    initiative = {
      title: text(declaration.title, "The document initiative.title"),
      intent: text(declaration.intent, "The document initiative.intent"),
      motivation: text(declaration.motivation, "The document initiative.motivation"),
      ordering: text(declaration.ordering, "The document initiative.ordering"),
    };
  }

  // Declaring an Initiative is declaring something: its intent and the shape of
  // a breakdown can be recorded before the breakdown exists, and an Initiative
  // delivered outside the backlog still deserves a local record.
  if (initiative === undefined && works.length === 0 && cancel.length === 0 && supersede.length === 0 && followUp.length === 0) fail("The document declares nothing.");

  return {
    schemaVersion: INITIATIVE_DOCUMENT_SCHEMA_VERSION,
    type: INITIATIVE_DOCUMENT_TYPE,
    documentId: text(record.documentId, "The document documentId"),
    summary: text(record.summary, "The document summary"),
    observedState: text(record.observedState, "The document observedState"),
    digest,
    createdAt,
    ...(record.intent === undefined ? {} : { intent: text(record.intent, "The document intent") }),
    ...(initiative === undefined ? {} : { initiative }),
    works,
    cancel,
    supersede,
    followUp,
  };
}
