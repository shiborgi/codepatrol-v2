import { CodepatrolError } from "./errors.js";

/**
 * Bounded, privacy-safe attempt telemetry.
 *
 * Privacy is a structural property, not a runtime check: every leaf is either a
 * non-negative safe integer or the literal `"unavailable"`. A prompt, response,
 * reasoning trace, raw output, environment value, or credential can never fit
 * this shape, and the parser refuses any field that would carry one. Adding a
 * new leaf that is a string is what the privacy test net in src/test catches.
 *
 * `tools` and `model` are deliberately `unavailable` rather than zero when the
 * harness does not report them: zero is a measurement, "unavailable" is an
 * admission that the harness did not provide one, and conflating them hides
 * capability gaps from INIT-1.7's derived metrics.
 *
 * Duration and command counts are deliberately not stored: `startedAt` and
 * `finishedAt` are already on every attempt, and `ManifestTrace` of type
 * `command` already carries an `exitCode`. INIT-1.7 derives them on read;
 * storing them here would create two sources of truth.
 */
export const TELEMETRY_UNAVAILABLE = "unavailable";

export interface AttemptTelemetrySkills {
  count: number;
  bytes: number;
}

export interface AttemptTelemetryContext {
  sections: number;
  bytes: number;
}

export interface AttemptTelemetryTools {
  count: number;
  failures: number;
  inputBytes: number;
  outputBytes: number;
}

export interface AttemptTelemetryModel {
  inputTokens: number;
  outputTokens: number;
}

export interface AttemptTelemetry {
  skills: AttemptTelemetrySkills;
  context: AttemptTelemetryContext;
  tools: typeof TELEMETRY_UNAVAILABLE | AttemptTelemetryTools;
  model: typeof TELEMETRY_UNAVAILABLE | AttemptTelemetryModel;
}

/**
 * What the harness hands to `complete --telemetry`. The collector decides how
 * to use this; the manifest stores the merged `AttemptTelemetry`.
 */
export interface TelemetryReport {
  tools?: AttemptTelemetryTools;
  model?: AttemptTelemetryModel;
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

function nonNegativeInt(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) corrupt(`${label} must be a non-negative safe integer.`);
  return value as number;
}

function parseSkills(record: Record<string, unknown>, label: string): AttemptTelemetrySkills {
  keys(record, ["count", "bytes"], ["count", "bytes"], label);
  return { count: nonNegativeInt(record["count"], `${label}.count`), bytes: nonNegativeInt(record["bytes"], `${label}.bytes`) };
}

function parseContext(record: Record<string, unknown>, label: string): AttemptTelemetryContext {
  keys(record, ["sections", "bytes"], ["sections", "bytes"], label);
  return { sections: nonNegativeInt(record["sections"], `${label}.sections`), bytes: nonNegativeInt(record["bytes"], `${label}.bytes`) };
}

function parseTools(record: Record<string, unknown>, label: string): AttemptTelemetryTools {
  keys(record, ["count", "failures", "inputBytes", "outputBytes"], ["count", "failures", "inputBytes", "outputBytes"], label);
  return {
    count: nonNegativeInt(record["count"], `${label}.count`),
    failures: nonNegativeInt(record["failures"], `${label}.failures`),
    inputBytes: nonNegativeInt(record["inputBytes"], `${label}.inputBytes`),
    outputBytes: nonNegativeInt(record["outputBytes"], `${label}.outputBytes`),
  };
}

function parseModel(record: Record<string, unknown>, label: string): AttemptTelemetryModel {
  keys(record, ["inputTokens", "outputTokens"], ["inputTokens", "outputTokens"], label);
  return {
    inputTokens: nonNegativeInt(record["inputTokens"], `${label}.inputTokens`),
    outputTokens: nonNegativeInt(record["outputTokens"], `${label}.outputTokens`),
  };
}

/**
 * Strict parse of an `AttemptTelemetry` from manifest JSON. Throws STATE_CORRUPT
 * on any unknown field, non-integer leaf, or string other than "unavailable",
 * so a tampered manifest cannot smuggle a content field past the privacy
 * boundary.
 */
export function parseAttemptTelemetry(value: unknown, label: string): AttemptTelemetry {
  const record = object(value, label);
  keys(record, ["skills", "context", "tools", "model"], ["skills", "context", "tools", "model"], label);
  const toolsValue = record["tools"];
  const tools: AttemptTelemetry["tools"] = toolsValue === TELEMETRY_UNAVAILABLE
    ? TELEMETRY_UNAVAILABLE
    : parseTools(object(toolsValue, `${label}.tools`), `${label}.tools`);
  const modelValue = record["model"];
  const model: AttemptTelemetry["model"] = modelValue === TELEMETRY_UNAVAILABLE
    ? TELEMETRY_UNAVAILABLE
    : parseModel(object(modelValue, `${label}.model`), `${label}.model`);
  return {
    skills: parseSkills(object(record["skills"], `${label}.skills`), `${label}.skills`),
    context: parseContext(object(record["context"], `${label}.context`), `${label}.context`),
    tools,
    model,
  };
}

/**
 * Strict parse of a `TelemetryReport` from the `--telemetry` file the harness
 * submits with `complete`. Only the harness-reportable leaves are accepted;
 * unknown fields are refused so the harness cannot smuggle a content field
 * into telemetry. Absent `tools` or `model` does not raise — the collector
 * records them as "unavailable" instead.
 */
export function parseTelemetryReport(value: unknown, label: string): TelemetryReport {
  const record = object(value, label);
  keys(record, ["tools", "model"], [], label);
  const report: TelemetryReport = {};
  if (record["tools"] !== undefined) report.tools = parseTools(object(record["tools"], `${label}.tools`), `${label}.tools`);
  if (record["model"] !== undefined) report.model = parseModel(object(record["model"], `${label}.model`), `${label}.model`);
  return report;
}
