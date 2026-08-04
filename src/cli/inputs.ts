import type { ResultInput } from "../application/work-service.js";
import { CodepatrolError } from "../core/errors.js";
import type { TelemetryReport } from "../core/telemetry.js";
import { RETURN_TARGETS, STAGES, type Stage, type TodoItem } from "../core/types.js";
import type { TraceInput } from "../application/work-service.js";
import type { ManifestTrace } from "../core/work-manifest.js";

/**
 * Parsers for the JSON documents an executor submits: todo, result, and trace.
 *
 * These reject unknown fields for the same reason the manifest parser does — a
 * misspelled key must fail rather than be silently dropped, because the caller
 * believes it said something it did not say.
 */

export function object(raw: unknown, label: string): Record<string, unknown> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new CodepatrolError("INVALID_INPUT", `${label} must be an object.`);
  return raw as Record<string, unknown>;
}

export function fields(record: Record<string, unknown>, allowed: readonly string[], required: readonly string[], label: string): void {
  const actual = Object.keys(record);
  const unknown = actual.find((key) => !allowed.includes(key));
  if (unknown !== undefined) throw new CodepatrolError("INVALID_INPUT", `${label} has an unknown field: ${unknown}.`);
  const missing = required.find((key) => !actual.includes(key));
  if (missing !== undefined) throw new CodepatrolError("INVALID_INPUT", `${label} is missing ${missing}.`);
}

export function nonEmptyText(raw: unknown, label: string): string {
  if (typeof raw !== "string" || raw.trim() === "") throw new CodepatrolError("INVALID_INPUT", `${label} must be a non-empty string.`);
  return raw;
}

export function parseTodo(raw: unknown): TodoItem[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new CodepatrolError("INVALID_INPUT", "The todo file must be a non-empty array.");
  const ids = new Set<string>();
  return raw.map((item, index) => {
    const label = `Todo item ${index + 1}`;
    const record = object(item, label);
    fields(record, ["id", "title", "description"], ["id", "title"], label);
    const id = nonEmptyText(record.id, `${label} id`);
    if (ids.has(id)) throw new CodepatrolError("INVALID_INPUT", `The todo file contains duplicate id: ${id}.`);
    ids.add(id);
    return {
      id,
      title: nonEmptyText(record.title, `${label} title`),
      ...(record.description === undefined ? {} : { description: nonEmptyText(record.description, `${label} description`) }),
    };
  });
}

function parseResultTodo(raw: unknown): ResultInput["todo"] {
  if (!Array.isArray(raw)) throw new CodepatrolError("INVALID_INPUT", "The result must answer its todo.");
  const ids = new Set<string>();
  return raw.map((rawItem, index) => {
    const label = `Result todo item ${index + 1}`;
    const item = object(rawItem, label);
    fields(item, ["id", "status", "note"], ["id", "status"], label);
    const id = nonEmptyText(item.id, `${label} id`);
    if (ids.has(id)) throw new CodepatrolError("INVALID_INPUT", `The result todo contains duplicate id: ${id}.`);
    ids.add(id);
    if (typeof item.status !== "string" || !["completed", "skipped", "failed"].includes(item.status)) {
      throw new CodepatrolError("INVALID_INPUT", `${label} status must be completed, skipped, or failed.`);
    }
    return {
      id,
      status: item.status as ResultInput["todo"][number]["status"],
      ...(item.note === undefined ? {} : { note: nonEmptyText(item.note, `${label} note`) }),
    };
  });
}

function parseResultArtifacts(raw: unknown): ResultInput["artifacts"] {
  const artifacts = raw ?? [];
  if (!Array.isArray(artifacts)) throw new CodepatrolError("INVALID_INPUT", "Artifacts must be an array.");
  const paths = new Set<string>();
  return artifacts.map((rawItem, index) => {
    const label = `Artifact ${index + 1}`;
    const item = object(rawItem, label);
    fields(item, ["path", "kind", "description"], ["path", "kind"], label);
    const artifactPath = nonEmptyText(item.path, `${label} path`);
    if (paths.has(artifactPath)) throw new CodepatrolError("INVALID_INPUT", `Artifacts contain duplicate path: ${artifactPath}.`);
    paths.add(artifactPath);
    return {
      path: artifactPath,
      kind: nonEmptyText(item.kind, `${label} kind`),
      ...(item.description === undefined ? {} : { description: nonEmptyText(item.description, `${label} description`) }),
    };
  });
}

export function parseResult(raw: unknown, stage: Stage): ResultInput {
  const record = object(raw, "The result");
  fields(record, ["decision", "summary", "handoff", "todo", "artifacts", "returnTo", "reasons", "authority"], ["decision", "summary", "handoff", "todo"], "The result");
  const allowed = stage === "ship" ? ["accept", "rollback"] : stage === "plan" ? ["continue"] : ["continue", "return"];
  if (typeof record.decision !== "string" || !allowed.includes(record.decision)) {
    throw new CodepatrolError("INVALID_INPUT", `${stage} must decide one of: ${allowed.join(", ")}.`);
  }
  const decision = record.decision as ResultInput["decision"];

  let returnTo: Stage | undefined;
  let reasons: string[] | undefined;
  if (decision === "return") {
    if (typeof record.returnTo !== "string" || !STAGES.includes(record.returnTo as Stage) || !RETURN_TARGETS[stage]?.includes(record.returnTo as Stage)) {
      throw new CodepatrolError("INVALID_INPUT", `${stage} returnTo is not allowed.`);
    }
    if (!Array.isArray(record.reasons) || record.reasons.length === 0) throw new CodepatrolError("INVALID_INPUT", "A return needs non-empty reasons.");
    reasons = record.reasons.map((reason, index) => nonEmptyText(reason, `Return reason ${index + 1}`));
    returnTo = record.returnTo as Stage;
  } else if (record.returnTo !== undefined || record.reasons !== undefined) {
    throw new CodepatrolError("INVALID_INPUT", "returnTo and reasons are only valid for a return decision.");
  }

  let authority: string | undefined;
  if (stage === "ship") authority = nonEmptyText(record.authority, "Ship authority");
  else if (record.authority !== undefined) throw new CodepatrolError("INVALID_INPUT", "authority is only valid for ship.");

  return {
    decision,
    summary: nonEmptyText(record.summary, "Result summary"),
    handoff: nonEmptyText(record.handoff, "Result handoff"),
    todo: parseResultTodo(record.todo),
    artifacts: parseResultArtifacts(record.artifacts),
    ...(returnTo === undefined ? {} : { returnTo }),
    ...(reasons === undefined ? {} : { reasons }),
    ...(authority === undefined ? {} : { authority }),
  };
}

const TRACE_TYPES = ["observation", "decision", "action", "error", "metric", "command"];

/**
 * Strict parse of a harness-submitted `--telemetry` file. Mirrors
 * `parseTelemetryReport` but reports malformed input as INVALID_INPUT — the
 * caller typed something wrong, not the manifest.
 */
export function parseTelemetryInput(raw: unknown): TelemetryReport {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new CodepatrolError("INVALID_INPUT", "Telemetry report must be an object.");
  }
  const record = raw as Record<string, unknown>;
  const allowed = ["tools", "model"];
  const unknown = Object.keys(record).find((key) => !allowed.includes(key));
  if (unknown !== undefined) throw new CodepatrolError("INVALID_INPUT", `Telemetry report has an unknown field: ${unknown}.`);
  const report: TelemetryReport = {};
  if (record["tools"] !== undefined) {
    if (record["tools"] === null || typeof record["tools"] !== "object" || Array.isArray(record["tools"])) {
      throw new CodepatrolError("INVALID_INPUT", "Telemetry report tools must be an object.");
    }
    const tools = record["tools"] as Record<string, unknown>;
    const toolsAllowed = ["count", "failures", "inputBytes", "outputBytes"];
    const toolsUnknown = Object.keys(tools).find((key) => !toolsAllowed.includes(key));
    if (toolsUnknown !== undefined) throw new CodepatrolError("INVALID_INPUT", `Telemetry report tools has an unknown field: ${toolsUnknown}.`);
    for (const field of toolsAllowed) {
      if (typeof tools[field] !== "number" || !Number.isSafeInteger(tools[field] as number) || (tools[field] as number) < 0) {
        throw new CodepatrolError("INVALID_INPUT", `Telemetry report tools.${field} must be a non-negative safe integer.`);
      }
    }
    report.tools = { count: tools["count"] as number, failures: tools["failures"] as number, inputBytes: tools["inputBytes"] as number, outputBytes: tools["outputBytes"] as number };
  }
  if (record["model"] !== undefined) {
    if (record["model"] === null || typeof record["model"] !== "object" || Array.isArray(record["model"])) {
      throw new CodepatrolError("INVALID_INPUT", "Telemetry report model must be an object.");
    }
    const model = record["model"] as Record<string, unknown>;
    const modelAllowed = ["inputTokens", "outputTokens"];
    const modelUnknown = Object.keys(model).find((key) => !modelAllowed.includes(key));
    if (modelUnknown !== undefined) throw new CodepatrolError("INVALID_INPUT", `Telemetry report model has an unknown field: ${modelUnknown}.`);
    for (const field of modelAllowed) {
      if (typeof model[field] !== "number" || !Number.isSafeInteger(model[field] as number) || (model[field] as number) < 0) {
        throw new CodepatrolError("INVALID_INPUT", `Telemetry report model.${field} must be a non-negative safe integer.`);
      }
    }
    report.model = { inputTokens: model["inputTokens"] as number, outputTokens: model["outputTokens"] as number };
  }
  return report;
}

export function parseTrace(raw: unknown): TraceInput {
  const record = object(raw, "A trace");
  fields(record, ["type", "message", "data", "command", "exitCode"], ["type", "message"], "A trace");
  if (typeof record.type !== "string" || !TRACE_TYPES.includes(record.type)) throw new CodepatrolError("INVALID_INPUT", `A trace type must be one of: ${TRACE_TYPES.join(", ")}.`);
  if (typeof record.message !== "string" || record.message.trim() === "") throw new CodepatrolError("INVALID_INPUT", "A trace needs a message.");
  if (record.data !== undefined) object(record.data, "Trace data");
  if (record.type === "command") {
    if (!Array.isArray(record.command) || record.command.length === 0 || record.command.some((part) => typeof part !== "string" || part === "")) throw new CodepatrolError("INVALID_INPUT", "A command trace needs a non-empty command array.");
    if (typeof record.exitCode !== "number" || !Number.isSafeInteger(record.exitCode)) throw new CodepatrolError("INVALID_INPUT", "A command trace needs an integer exitCode.");
  } else if (record.command !== undefined || record.exitCode !== undefined) throw new CodepatrolError("INVALID_INPUT", "command and exitCode require trace type command.");
  return {
    type: record.type as ManifestTrace["type"],
    message: record.message,
    ...(record.data === undefined ? {} : { data: record.data as Record<string, unknown> }),
    ...(record.command === undefined ? {} : { command: record.command as string[] }),
    ...(record.exitCode === undefined ? {} : { exitCode: record.exitCode as number }),
  };
}
