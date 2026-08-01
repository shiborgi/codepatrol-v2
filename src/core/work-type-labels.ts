import { ISSUE_TYPES, type IssueType } from "./types.js";

export const WORK_TYPE_LABEL_NAMESPACE = "codepatrol:type/";

export interface WorkTypeLabelDefinition {
  name: string;
  description: string;
  color: string;
}

export const DEFAULT_WORK_TYPE_LABELS: Readonly<Record<IssueType, WorkTypeLabelDefinition>> = {
  Bug: { name: "codepatrol:type/bug", description: "CodePatrol Work type: Bug", color: "d73a4a" },
  Feature: { name: "codepatrol:type/feature", description: "CodePatrol Work type: Feature", color: "a2eeef" },
  Task: { name: "codepatrol:type/task", description: "CodePatrol Work type: Task", color: "ededed" },
};

export interface GitHubIssueClassificationConfig {
  mode: "labels";
  labels: Readonly<Record<IssueType, string>>;
}

export function defaultIssueClassification(): GitHubIssueClassificationConfig {
  return {
    mode: "labels",
    labels: {
      Bug: DEFAULT_WORK_TYPE_LABELS.Bug.name,
      Feature: DEFAULT_WORK_TYPE_LABELS.Feature.name,
      Task: DEFAULT_WORK_TYPE_LABELS.Task.name,
    },
  };
}

/**
 * The remote label that projects a canonical local `Work.issueType`.
 *
 * Names come from configuration; descriptions and colors are deterministic so
 * repeated synchronization never recreates a label with drifting metadata.
 */
export function resolveWorkTypeLabel(issueType: IssueType, classification: GitHubIssueClassificationConfig): WorkTypeLabelDefinition {
  const defaults = DEFAULT_WORK_TYPE_LABELS[issueType];
  return { name: classification.labels[issueType], description: defaults.description, color: defaults.color };
}

/**
 * Managed labels are the configured Work type labels plus anything inside the
 * CodePatrol namespace, so migration and cleanup recognize prior defaults even
 * when the configuration now points elsewhere. User labels never match.
 */
export function isManagedWorkTypeLabel(label: string, classification: GitHubIssueClassificationConfig): boolean {
  return ISSUE_TYPES.some((type) => classification.labels[type] === label) || label.startsWith(WORK_TYPE_LABEL_NAMESPACE);
}
