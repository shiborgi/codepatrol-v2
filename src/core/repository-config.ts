import { CodepatrolError } from "./errors.js";
import { ISSUE_TYPES, type IssueType } from "./types.js";
import { defaultIssueClassification, type GitHubIssueClassificationConfig } from "./work-type-labels.js";

export const REPOSITORY_CONFIG_PATH = ".codepatrol/config.json";
export const REPOSITORY_CONFIG_SCHEMA_VERSION = 1;

export type Harness = "none" | "opencode" | "claude";
export type ProjectConfig =
  | { mode: "disabled" }
  | { mode: "managed" }
  | { mode: "existing"; number: number };

export interface RepositoryConfig {
  schemaVersion: typeof REPOSITORY_CONFIG_SCHEMA_VERSION;
  baseBranch: string;
  harness: Harness;
  github: {
    refs: { enabled: boolean };
    issue: { enabled: boolean; classification: GitHubIssueClassificationConfig };
    milestone: { enabled: boolean };
    project: ProjectConfig;
  };
}

function invalid(message: string): never {
  throw new CodepatrolError("INVALID_CONFIG", `${REPOSITORY_CONFIG_PATH} ${message}`);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function keys(record: Record<string, unknown>, allowed: readonly string[], required: readonly string[], label: string): void {
  const unknown = Object.keys(record).find((key) => !allowed.includes(key));
  if (unknown !== undefined) invalid(`${label} has an unknown field: ${unknown}.`);
  const missing = required.find((key) => record[key] === undefined);
  if (missing !== undefined) invalid(`${label} is missing ${missing}.`);
}

function enabled(value: unknown, label: string): { enabled: boolean } {
  const record = object(value, label);
  keys(record, ["enabled"], ["enabled"], label);
  if (typeof record.enabled !== "boolean") invalid(`${label}.enabled must be a boolean.`);
  return { enabled: record.enabled };
}

function classification(value: unknown): GitHubIssueClassificationConfig {
  const label = "github.issue.classification";
  const record = object(value, label);
  keys(record, ["mode", "labels"], ["mode", "labels"], label);
  if (record.mode !== "labels") invalid(`${label}.mode must be labels.`);
  const labels = object(record.labels, `${label}.labels`);
  const types = ISSUE_TYPES as readonly string[];
  const unknown = Object.keys(labels).find((key) => !types.includes(key));
  if (unknown !== undefined) invalid(`${label}.labels has an unknown work type: ${unknown}.`);
  const missing = types.find((key) => labels[key] === undefined);
  if (missing !== undefined) invalid(`${label}.labels is missing ${missing}.`);
  const names = types.map((key) => labels[key]);
  if (names.some((name) => typeof name !== "string" || name.trim() === "")) invalid(`${label}.labels values must be non-empty strings.`);
  const duplicate = names.find((name, index) => names.indexOf(name) !== index);
  if (duplicate !== undefined) invalid(`${label}.labels maps more than one work type to ${duplicate}.`);
  return {
    mode: "labels",
    labels: { Bug: labels.Bug as string, Feature: labels.Feature as string, Task: labels.Task as string } as Record<IssueType, string>,
  };
}

function issue(value: unknown): { enabled: boolean; classification: GitHubIssueClassificationConfig } {
  const label = "github.issue";
  const record = object(value, label);
  keys(record, ["enabled", "classification"], ["enabled"], label);
  if (typeof record.enabled !== "boolean") invalid(`${label}.enabled must be a boolean.`);
  return {
    enabled: record.enabled,
    classification: record.classification === undefined ? defaultIssueClassification() : classification(record.classification),
  };
}

export function parseRepositoryConfig(raw: string): RepositoryConfig {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch (error) {
    invalid(`contains invalid JSON: ${error instanceof Error ? error.message : String(error)}.`);
  }
  const record = object(value, "document");
  keys(record, ["schemaVersion", "baseBranch", "harness", "github"], ["schemaVersion", "baseBranch", "harness", "github"], "document");
  if (record.schemaVersion !== REPOSITORY_CONFIG_SCHEMA_VERSION) invalid(`schemaVersion must be ${REPOSITORY_CONFIG_SCHEMA_VERSION}.`);
  if (typeof record.baseBranch !== "string" || record.baseBranch.trim() === "" || record.baseBranch.startsWith("refs/")) {
    invalid("baseBranch must be a short branch name.");
  }
  if (!(["none", "opencode", "claude"] as unknown[]).includes(record.harness)) invalid("harness must be none, opencode, or claude.");
  const github = object(record.github, "github");
  keys(github, ["refs", "issue", "milestone", "project"], ["refs", "issue", "project"], "github");
  const project = object(github.project, "github.project");
  keys(project, ["mode", "number"], ["mode"], "github.project");
  if (!(["disabled", "managed", "existing"] as unknown[]).includes(project.mode)) invalid("github.project.mode must be disabled, managed, or existing.");
  if (project.mode === "existing") {
    if (!Number.isSafeInteger(project.number) || (project.number as number) <= 0) invalid("github.project.number must be a positive integer in existing mode.");
  } else if (project.number !== undefined) {
    invalid("github.project.number is only valid in existing mode.");
  }
  const issueConfig = issue(github.issue);
  if (project.mode !== "disabled" && !issueConfig.enabled) invalid("github.issue must be enabled when Project projection is enabled.");
  const milestone = github.milestone === undefined ? { enabled: false } : enabled(github.milestone, "github.milestone");
  if (milestone.enabled && !issueConfig.enabled) invalid("github.issue must be enabled when Milestone projection is enabled.");
  return {
    schemaVersion: REPOSITORY_CONFIG_SCHEMA_VERSION,
    baseBranch: record.baseBranch,
    harness: record.harness as Harness,
    github: {
      refs: enabled(github.refs, "github.refs"),
      issue: issueConfig,
      milestone,
      project: project.mode === "existing"
        ? { mode: "existing", number: project.number as number }
        : { mode: project.mode as "disabled" | "managed" },
    },
  };
}

export function serializeRepositoryConfig(config: RepositoryConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}
