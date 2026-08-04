import type { GitManifestStore } from "../adapters/manifest-store.js";
import type { GitHubIssue, GitHubProject, GitHubIssues, GitHubLabels, GitHubMilestones, GitHubProjects, GitHubRepository, GitRemote, GitSyncResult } from "./ports.js";
import { CodepatrolError } from "../core/errors.js";
import { PROJECT_OUTCOME_BY_WORK_OUTCOME, PROJECT_STATUS_BY_STAGE, nextStepOf, type NextStep, type ProjectOutcome, type ProjectStatus } from "../core/types.js";
import type { WorkManifest } from "../core/work-manifest.js";
import { defaultIssueClassification, resolveWorkTypeLabel, type GitHubIssueClassificationConfig } from "../core/work-type-labels.js";
import { manifestComments, reconcileIssueComments, type CommentSyncSummary, type DesiredIssueComment } from "./issue-comments.js";
import { ALL_PROJECTIONS, projecting, type Projections } from "./projections.js";
import { indexWorks, matchIssue } from "./publication/mapping.js";
import { initiativeSection } from "./publication/markers.js";
import { desiredIssueBody, desiredIssueTitle, reconcileIssueContent, reconcileIssueState, type ProjectionWarning } from "./publication/reconcile.js";

interface IssueSummary {
  created: Array<{ issue: number; workId: string }>;
  updated: Array<{ issue: number; workId: string }>;
  unchanged: Array<{ issue: number; workId: string }>;
  unclaimed: number[];
}

export interface PublicationResult {
  repository: string;
  remote: string;
  git: { beforeIssues: GitSyncResult; afterIssues: GitSyncResult };
  issues: IssueSummary;
  comments: CommentSyncSummary;
  milestones: Array<{ initiative: string; number: number }>;
  project: { number: number; title: string; statuses: Array<{ workId: string; status: ProjectStatus; outcome: ProjectOutcome; next: NextStep }> };
  warnings: ProjectionWarning[];
}

interface PublicationSnapshot {
  comments: DesiredIssueComment[];
  terminal: boolean;
  projectStatus: ProjectStatus;
  projectOutcome: ProjectOutcome;
  next: NextStep;
}

/** What a disabled ref projection reports: the remote exists, nothing was pushed to it. */
function unpublishedRefs(remote: string): GitSyncResult {
  return { remote, remoteConfigured: true, refs: [] };
}

function snapshotOf(manifest: WorkManifest): PublicationSnapshot {
  const latest = manifest.attempts.at(-1);
  const completion = manifest.completion;
  // The board reports activity, not readiness: a Work no run has ever attacked
  // stays Backlog, a live run shows its stage, a Work waiting between runs
  // keeps the stage last attacked, and a terminal Work shows Done. The latest
  // attempt's stage is the stage an attack last touched — workflow.stage is
  // the stage the Work is ready for, which is what the board used to advertise
  // and the defect this rule replaces.
  const projectStatus = completion !== null ? "Done"
    : latest === undefined ? "Backlog"
      : PROJECT_STATUS_BY_STAGE[latest.stage];
  const projectOutcome = completion === null ? "None"
    : PROJECT_OUTCOME_BY_WORK_OUTCOME[completion.outcome];
  const next = nextStepOf(manifest);
  return { comments: manifestComments(manifest), terminal: completion !== null, projectStatus, projectOutcome, next };
}

/**
 * Projects local Works onto GitHub Issues and a Project board.
 *
 * Ordering contract:
 * 1. Refs are published (without cleanup) so Work IDs are visible remotely.
 * 2. Issues are resolved, created, and content-reconciled.
 * 3. Project Status and Outcome are reconciled.
 * 4. Terminal Issues are closed.
 * 5. Refs are synchronized again with cleanup enabled, so terminal Work
 *    branches are deleted only after every projection has been finalized.
 *
 * A failure in any projection does not undo earlier ones: the local fact is
 * already committed, and the next sync converges.
 */
export class PublicationService {
  constructor(
    private readonly store: GitManifestStore,
    private readonly remote: GitRemote,
    private readonly github: GitHubIssues,
    private readonly labels: GitHubLabels,
    private readonly projects: GitHubProjects,
    private readonly milestones: GitHubMilestones,
    private readonly classification: GitHubIssueClassificationConfig = defaultIssueClassification(),
    private readonly projections: Projections = ALL_PROJECTIONS,
  ) {}

  private async isTerminal(workId: string): Promise<boolean> {
    try {
      return (await this.store.read(workId)).manifest.completion !== null;
    } catch (error) {
      if (error instanceof CodepatrolError && error.code === "WORK_NOT_FOUND") return false;
      throw error;
    }
  }

  async reconcile(input: { repository?: string; remote: string; workId?: string }): Promise<PublicationResult> {
    return this.remote.exclusive(() => this.syncExclusive(input));
  }

  async automatic(input: { remote?: string; workId?: string }): Promise<PublicationResult | undefined> {
    const remote = input.remote ?? "origin";
    let workId: string | undefined;
    if (input.workId !== undefined) {
      workId = await this.store.resolve(input.workId);
      await this.store.read(workId);
    }
    // A resolvable remote is not permission to use it: a repository that has
    // turned every projection off must reach GitHub no more than one without a
    // remote does.
    if (!projecting(this.projections)) return undefined;
    const repository = await this.remote.resolveRepository(remote);
    if (repository === undefined) return undefined;
    return this.reconcile({ repository, remote, ...(workId === undefined ? {} : { workId }) });
  }

  private async resolveIssues(
    resolved: GitHubRepository,
    entryById: Map<string, WorkManifest>,
    viewer: string,
    summary: IssueSummary,
    selectedWorkId?: string,
  ): Promise<Map<string, GitHubIssue>> {
    const issues = await this.github.list(resolved.nameWithOwner);
    const issueByWork = new Map<string, GitHubIssue>();
    const index = indexWorks([...entryById.values()], resolved.nameWithOwner);

    for (const issue of issues) {
      const match = matchIssue(issue, index, resolved.nameWithOwner, viewer, selectedWorkId);
      if (selectedWorkId !== undefined && !match.concernsSelected) continue;
      const entry = match.entry;
      if (entry === undefined) {
        summary.unclaimed.push(issue.number);
        continue;
      }
      const existing = issueByWork.get(entry.work.id);
      if (existing !== undefined && existing.number !== issue.number) throw new CodepatrolError("SYNC_CONFLICT", `Work ${entry.work.id} maps to multiple issues.`);
      issueByWork.set(entry.work.id, issue);
    }
    return issueByWork;
  }

  private async syncExclusive(input: { repository?: string; remote: string; workId?: string }): Promise<PublicationResult> {
    const workId = input.workId === undefined ? undefined : await this.store.resolve(input.workId);
    const requested = input.repository ?? await this.remote.resolveRepository(input.remote);
    if (requested === undefined) {
      throw new CodepatrolError("INVALID_ARGUMENT", `Remote ${input.remote} is not a configured GitHub remote; pass --repo <owner/name>.`, 2);
    }
    const resolved = await this.github.resolve(requested);
    const scope = workId === undefined ? undefined : { workId };
    const policy = { isTerminal: (workId: string) => this.isTerminal(workId) };

    // Phase 1: publish refs without cleanup so terminal branches survive until
    // every projection has been finalized.
    const beforeIssues = this.projections.refs
      ? await this.remote.sync(input.remote, resolved.gitUrl, { ...policy, cleanup: false }, scope)
      : unpublishedRefs(input.remote);

    const allEntries = (await this.store.list()).map((revision) => revision.manifest);
    if (workId !== undefined && !allEntries.some((entry) => entry.work.id === workId)) {
      throw new CodepatrolError("WORK_NOT_FOUND", `Work not found: ${workId}.`);
    }
    const entryById = new Map(allEntries.map((entry) => [entry.work.id, entry]));
    const summary: IssueSummary = { created: [], updated: [], unchanged: [], unclaimed: [] };
    const comments: CommentSyncSummary = { created: [], updated: [], deleted: [], unchanged: [] };
    const warnings: ProjectionWarning[] = [];
    const changedWorks = new Set<string>();

    // Every Issue-shaped projection is skipped together, including the reads:
    // a disabled projection must not even ask GitHub who the viewer is.
    const viewer = this.projections.issue ? await this.github.viewer() : "";
    const issueByWork = this.projections.issue
      ? await this.resolveIssues(resolved, entryById, viewer, summary, workId)
      : new Map<string, GitHubIssue>();

    for (const [workId, issue] of issueByWork) {
      const linked = await this.store.linkIssue(workId, { repository: resolved.nameWithOwner, number: issue.number });
      entryById.set(workId, linked.manifest);
    }

    const published = workId === undefined
      ? [...entryById.values()]
      : [entryById.get(workId)].filter((entry): entry is WorkManifest => entry !== undefined);
    const publication = new Map<string, PublicationSnapshot>();
    for (const entry of [...published].sort((left, right) => left.work.id.localeCompare(right.work.id))) {
      publication.set(entry.work.id, snapshotOf(entry));
    }

    const require = <T>(value: T | undefined, workId: string, what: string): T => {
      if (value === undefined) throw new CodepatrolError("SYNC_CONFLICT", `Work ${workId} has no ${what}.`);
      return value;
    };

    for (const [workId, listed] of issueByWork) {
      const entry = require(entryById.get(workId), workId, "manifest");
      const current = await this.github.get(resolved.nameWithOwner, listed.number);
      const reconciled = await reconcileIssueContent(this.github, this.labels, resolved.nameWithOwner, current, entry, this.classification);
      issueByWork.set(workId, reconciled.issue);
      warnings.push(...reconciled.warnings);
      if (reconciled.changed) changedWorks.add(workId);
    }

    for (const entry of this.projections.issue ? published : []) {
      if (issueByWork.has(entry.work.id)) continue;
      const desired = resolveWorkTypeLabel(entry.work.issueType, this.classification);
      const ensured = await this.labels.ensure(resolved.nameWithOwner, desired);
      if (ensured.status === "unavailable") {
        warnings.push({
          code: "GITHUB_ISSUE_LABEL_UNAVAILABLE",
          message: "The Issue was created without the managed Work type label.",
          repository: resolved.nameWithOwner,
          workId: entry.work.id,
          label: desired.name,
          next: "Grant label permissions or retry synchronization.",
        });
      }
      const issue = await this.github.create(resolved.nameWithOwner, {
        title: desiredIssueTitle(entry),
        body: desiredIssueBody(entry),
        ...(ensured.status === "unavailable" ? {} : { labels: [desired.name] }),
      });
      issueByWork.set(entry.work.id, issue);
      const linked = await this.store.linkIssue(entry.work.id, { repository: resolved.nameWithOwner, number: issue.number });
      entryById.set(entry.work.id, linked.manifest);
      summary.created.push({ issue: issue.number, workId: entry.work.id });
    }

    for (const entry of this.projections.issue ? published : []) {
      const issue = require(issueByWork.get(entry.work.id), entry.work.id, "synchronized issue");
      const desired = publication.get(entry.work.id)?.comments ?? [];
      if (desired.length === 0) continue;
      const result = await reconcileIssueComments(this.github, resolved.nameWithOwner, issue.number, viewer, desired);
      comments.created.push(...result.created);
      comments.updated.push(...result.updated);
      comments.deleted.push(...result.deleted);
      comments.unchanged.push(...result.unchanged);
    }

    const projectStatuses: Array<{ workId: string; status: ProjectStatus; outcome: ProjectOutcome; next: NextStep }> = [];
    let project: GitHubProject | undefined;
    // The board is an Issue view: with Issues disabled there is nothing to place
    // on it, so the Project projection has no independent existence.
    for (const entry of this.projections.project && this.projections.issue ? published : []) {
      const issue = require(issueByWork.get(entry.work.id), entry.work.id, "synchronized issue");
      const snapshot = require(publication.get(entry.work.id), entry.work.id, "Project publication state");
      project ??= await this.projects.ensure(resolved);
      await this.projects.reconcile(project, issue, snapshot.projectStatus, snapshot.projectOutcome, snapshot.next);
      projectStatuses.push({ workId: entry.work.id, status: snapshot.projectStatus, outcome: snapshot.projectOutcome, next: snapshot.next });
    }

    // One Milestone per Initiative that has published Works with Issues. The
    // board is an Issue view, so with Issues disabled there is nothing to pin.
    const milestones: Array<{ initiative: string; number: number }> = [];
    if (this.projections.milestone && this.projections.issue) {
      const byInitiative = new Map<string, Array<{ entry: WorkManifest; issue: GitHubIssue }>>();
      for (const entry of published) {
        const issue = issueByWork.get(entry.work.id);
        if (issue === undefined) continue;
        byInitiative.set(entry.work.initiative.id, [...(byInitiative.get(entry.work.initiative.id) ?? []), { entry, issue }]);
      }
      for (const [initiativeId, members] of [...byInitiative.entries()].sort((left, right) => left[0].localeCompare(right[0]))) {
        const initiative = await this.store.readInitiative(initiativeId).catch((error: unknown) => {
          if (error instanceof CodepatrolError && error.code === "WORK_NOT_FOUND") return undefined;
          throw error;
        });
        if (initiative === undefined) continue;
        const section = initiativeSection({
          title: initiative.title,
          intent: initiative.intent,
          motivation: initiative.motivation,
          ordering: initiative.ordering,
          works: members.map(({ entry }) => ({ id: entry.work.id, title: entry.work.title })),
        });
        const milestone = await this.milestones.ensure(resolved.nameWithOwner, initiative.title, section);
        for (const { issue } of members) await this.milestones.attachIssue(resolved.nameWithOwner, issue.number, milestone.number);
        milestones.push({ initiative: initiativeId, number: milestone.number });
      }
    }

    for (const entry of this.projections.issue ? published : []) {
      const issue = require(issueByWork.get(entry.work.id), entry.work.id, "synchronized issue");
      const terminal = publication.get(entry.work.id)?.terminal ?? false;
      const reconciled = await reconcileIssueState(this.github, resolved.nameWithOwner, issue, terminal);
      issueByWork.set(entry.work.id, reconciled.issue);
      if (reconciled.changed) changedWorks.add(entry.work.id);

      if (summary.created.some((item) => item.workId === entry.work.id)) continue;
      const item = { issue: reconciled.issue.number, workId: entry.work.id };
      if (changedWorks.has(entry.work.id)) summary.updated.push(item);
      else summary.unchanged.push(item);
    }

    // Phase 2: cleanup is now safe — every enabled projection has been
    // finalized, so terminal Work branches may be deleted.
    const afterIssues = this.projections.refs
      ? await this.remote.sync(input.remote, resolved.gitUrl, { ...policy, cleanup: true }, scope)
      : unpublishedRefs(input.remote);
    return {
      repository: resolved.nameWithOwner,
      remote: input.remote,
      git: { beforeIssues, afterIssues },
      issues: summary,
      comments,
      milestones,
      project: project === undefined ? { number: 0, title: "", statuses: [] } : { number: project.number, title: project.title, statuses: projectStatuses },
      warnings,
    };
  }
}
