import type { WorkManifest } from "../../core/work-manifest.js";
import { workCodeOf } from "../../core/identifiers.js";
import { isManagedWorkTypeLabel, resolveWorkTypeLabel, type GitHubIssueClassificationConfig } from "../../core/work-type-labels.js";
import type { GitHubIssue, GitHubIssues, GitHubIssueUpdate, GitHubLabels } from "../ports.js";
import { addMarker, setManagedWorkSection } from "./markers.js";

export interface ProjectionWarning {
  code: "GITHUB_ISSUE_LABEL_UNAVAILABLE" | "GITHUB_ISSUE_LABEL_DRIFT";
  message: string;
  repository: string;
  workId?: string;
  issue?: number;
  label?: string;
  next?: string;
}

export interface ReconciledIssue {
  issue: GitHubIssue;
  changed: boolean;
  warnings: ProjectionWarning[];
}

export function desiredIssueBody(entry: WorkManifest): string {
  return addMarker(setManagedWorkSection(entry.work.description, {
    workId: entry.work.id,
    issueType: entry.work.issueType,
    priority: entry.work.priority,
    stage: entry.workflow.stage,
  }), entry.work.id);
}

/**
 * The Issue title a Work projects: the short code first, so a list, a board,
 * and a search read it as a handle, then the Work title. Creation and
 * reconciliation go through this one helper so the form can never drift.
 */
export function desiredIssueTitle(entry: WorkManifest): string {
  return `${workCodeOf(entry.work.id)}: ${entry.work.title}`;
}

/**
 * Brings an Issue's managed fields in line with the local Work.
 *
 * Title, the managed body section, the hidden marker, and exactly one managed
 * Work type label are managed; user labels and human prose survive, because
 * the Issue is a projection of the Work and not a second place to author it.
 * Label failures degrade to warnings: they never block content synchronization.
 */
export async function reconcileIssueContent(
  github: GitHubIssues,
  labels: GitHubLabels,
  repository: string,
  issue: GitHubIssue,
  entry: WorkManifest,
  classification: GitHubIssueClassificationConfig,
): Promise<ReconciledIssue> {
  const warnings: ProjectionWarning[] = [];
  const desiredBody = addMarker(setManagedWorkSection(issue.body, {
    workId: entry.work.id,
    issueType: entry.work.issueType,
    priority: entry.work.priority,
    stage: entry.workflow.stage,
  }), entry.work.id);
  const desired = resolveWorkTypeLabel(entry.work.issueType, classification);
  const managed = issue.labels.filter((label) => isManagedWorkTypeLabel(label, classification));
  const obsolete = managed.filter((label) => label !== desired.name);
  const hasDesired = issue.labels.includes(desired.name);

  const update: GitHubIssueUpdate = {
    ...(issue.title === desiredIssueTitle(entry) ? {} : { title: desiredIssueTitle(entry) }),
    ...(desiredBody === issue.body ? {} : { body: desiredBody }),
  };

  if (!hasDesired || obsolete.length > 0) {
    const ensured = await labels.ensure(repository, desired);
    if (ensured.status === "unavailable") {
      warnings.push({
        code: "GITHUB_ISSUE_LABEL_UNAVAILABLE",
        message: "The Issue is synchronized without the managed Work type label.",
        repository,
        workId: entry.work.id,
        issue: issue.number,
        label: desired.name,
        next: "Grant label permissions or retry synchronization.",
      });
    } else {
      if (!hasDesired) update.addLabels = [desired.name];
      if (obsolete.length > 0) update.removeLabels = obsolete;
      warnings.push({
        code: "GITHUB_ISSUE_LABEL_DRIFT",
        message: "Managed Work type labels drifted and were reconciled.",
        repository,
        workId: entry.work.id,
        issue: issue.number,
        label: desired.name,
      });
    }
  }

  const changed = update.title !== undefined || update.body !== undefined || update.addLabels !== undefined || update.removeLabels !== undefined;
  if (!changed) return { issue, changed: false, warnings };
  const edited = await github.edit(repository, issue, update);
  return { issue: edited, changed: true, warnings };
}

/** Closes an Issue once its Work is terminal, and reopens it if it is not. */
export async function reconcileIssueState(
  github: GitHubIssues,
  repository: string,
  issue: GitHubIssue,
  terminal: boolean,
): Promise<ReconciledIssue> {
  const desiredState = terminal ? "closed" : "open";
  if (issue.state === desiredState) return { issue, changed: false, warnings: [] };
  return { issue: await github.edit(repository, issue, { state: desiredState }), changed: true, warnings: [] };
}
