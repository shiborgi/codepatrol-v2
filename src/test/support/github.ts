import type {
  GitHubComment,
  GitHubIssue,
  GitHubIssueInput,
  GitHubIssues,
  GitHubIssueUpdate,
  GitHubLabelDefinition,
  GitHubLabelEnsureResult,
  GitHubLabels,
  GitHubMilestone,
  GitHubMilestones,
  GitHubProject,
  GitHubProjects,
  GitHubRepository,
  GitRemote,
  GitSyncResult,
} from "../../application/ports.js";
import { CodepatrolError } from "../../core/errors.js";
import type { ProjectOutcome, ProjectStatus } from "../../core/types.js";
import { DEFAULT_WORK_TYPE_LABELS } from "../../core/work-type-labels.js";
import { setInitiativeSection, initiativeTitleOf, readInitiativeIdFromSection } from "../../application/publication/markers.js";

/**
 * One port-level fake for every GitHub surface. Anything above the adapter
 * layer uses this; `gh`-argv fakes belong to adapter tests only, via
 * {@link ghScript}. The two layers are deliberate, not an accident.
 */
export class FakeGitHub implements GitHubIssues, GitHubProjects {
  readonly repository: GitHubRepository = { nameWithOwner: "shiborgi/codepatrol", gitUrl: "https://github.com/shiborgi/codepatrol" };
  readonly issues: GitHubIssue[];
  readonly comments: Array<GitHubComment & { issue: number }> = [];
  readonly repositoryLabels: GitHubLabelDefinition[] = Object.values(DEFAULT_WORK_TYPE_LABELS).map((label) => ({ ...label }));
  readonly milestones: GitHubMilestone[] = [];
  private nextMilestone = 1000;
  readonly statuses = new Map<string, ProjectStatus>();
  readonly outcomes = new Map<string, ProjectOutcome>();
  readonly calls: Array<{ op: string; args: unknown }> = [];
  readonly project: GitHubProject = {
    id: "project-1",
    number: 1,
    owner: "shiborgi",
    title: "Codepatrol: shiborgi/codepatrol",
    statusFieldId: "status-field",
    statusOptions: { Backlog: "backlog", Plan: "plan", Review: "review", Build: "build", Verify: "verify", Ship: "ship", Done: "done" },
    outcomeFieldId: "outcome-field",
    outcomeOptions: { None: "none", Accepted: "accepted", "Rolled back": "rolled-back", Superseded: "superseded", Cancelled: "cancelled" },
  };

  viewerLogin = "codepatrol";
  failNextCommentCreate = false;
  failAfterNextCommentCreate = false;
  /** When true, label ensure degrades to `unavailable` like a permission-limited repository. */
  labelsUnavailable = false;
  private readonly failures = new Map<string, Error>();

  constructor(issues: GitHubIssue[] = []) {
    this.issues = issues;
  }

  /** Makes the next call to `op` throw, once. */
  failNext(op: string, error: Error = new CodepatrolError("GH_ERROR", `Injected ${op} failure.`)): void {
    this.failures.set(op, error);
  }

  private record(op: string, args: unknown): void {
    this.calls.push({ op, args });
    const failure = this.failures.get(op);
    if (failure !== undefined) {
      this.failures.delete(op);
      throw failure;
    }
  }

  /** Adds an issue as if it already existed on GitHub. */
  async create(repository: string, input: GitHubIssueInput): Promise<GitHubIssue> {
    return this.createIssue(repository, input);
  }

  seedIssue(input: Partial<GitHubIssue> & { number: number }): GitHubIssue {
    const issue: GitHubIssue = {
      title: `Issue ${input.number}`,
      body: "",
      state: "open",
      author: "octocat",
      url: `https://github.test/issues/${input.number}`,
      labels: [],
      ...input,
    };
    this.issues.push(issue);
    return issue;
  }

  issue(number: number): GitHubIssue {
    const found = this.issues.find((candidate) => candidate.number === number);
    if (found === undefined) throw new Error(`No fake issue #${number}.`);
    return found;
  }

  commentsFor(issueNumber: number): GitHubComment[] {
    return this.comments.filter((comment) => comment.issue === issueNumber).map(({ issue: _issue, ...comment }) => comment);
  }

  async viewer(): Promise<string> {
    this.record("viewer", undefined);
    return this.viewerLogin;
  }

  async resolve(): Promise<GitHubRepository> {
    this.record("resolve", undefined);
    return this.repository;
  }

  async list(): Promise<GitHubIssue[]> {
    this.record("list", undefined);
    return this.issues.map((issue) => ({ ...issue }));
  }

  async get(_repository: string, issueNumber: number): Promise<GitHubIssue> {
    this.record("get", issueNumber);
    return { ...this.issue(issueNumber) };
  }

  private async createIssue(_repository: string, input: GitHubIssueInput): Promise<GitHubIssue> {
    this.record("create", { title: input.title, labels: input.labels ?? [] });
    const number = Math.max(0, ...this.issues.map((issue) => issue.number)) + 1;
    const issue: GitHubIssue = { number, title: input.title, body: input.body, state: "open", author: "codepatrol", authorAssociation: "OWNER", url: `https://github.test/issues/${number}`, labels: [...(input.labels ?? [])] };
    this.issues.push(issue);
    return { ...issue, labels: [...issue.labels] };
  }

  async edit(_repository: string, issue: GitHubIssue, input: GitHubIssueUpdate): Promise<GitHubIssue> {
    this.record("edit", { issue: issue.number, input });
    const stored = this.issue(issue.number);
    if (input.title !== undefined) stored.title = input.title;
    if (input.body !== undefined) stored.body = input.body;
    if (input.state !== undefined) stored.state = input.state;
    if (input.removeLabels !== undefined) stored.labels = stored.labels.filter((label) => !(input.removeLabels ?? []).includes(label));
    for (const label of input.addLabels ?? []) if (!stored.labels.includes(label)) stored.labels.push(label);
    return { ...stored, labels: [...stored.labels] };
  }

  /**
   * Label operations under distinct names: `list` and `ensure` already belong
   * to the Issue and Project surfaces on this one fake. {@link labelsPort}
   * adapts them to the real {@link GitHubLabels} contract.
   */
  async listLabels(_repository: string): Promise<GitHubLabelDefinition[]> {
    this.record("label.list", undefined);
    return this.repositoryLabels.map((label) => ({ ...label }));
  }

  async ensureLabel(_repository: string, label: GitHubLabelDefinition): Promise<GitHubLabelEnsureResult> {
    this.record("label.ensure", label);
    if (this.labelsUnavailable) {
      return { status: "unavailable", label, warning: "Label management is not permitted for this repository." };
    }
    const existing = this.repositoryLabels.find((candidate) => candidate.name === label.name);
    if (existing !== undefined) return { status: "existing", label: { ...existing } };
    this.repositoryLabels.push({ ...label });
    return { status: "created", label: { ...label } };
  }

  get labelsPort(): GitHubLabels {
    return {
      list: (repository) => this.listLabels(repository),
      ensure: (repository, label) => this.ensureLabel(repository, label),
    };
  }

  async listMilestones(_repository: string): Promise<GitHubMilestone[]> {
    this.record("milestone.list", undefined);
    return this.milestones.map((milestone) => ({ ...milestone }));
  }

  async ensureMilestone(_repository: string, initiative: { id: string; title: string }, section: string): Promise<GitHubMilestone> {
    const desiredTitle = initiativeTitleOf(initiative);
    this.record("milestone.ensure", { initiative, desiredTitle });

    // (a) exact new title
    const exactMatch = this.milestones.find((milestone) => milestone.title === desiredTitle);
    if (exactMatch !== undefined) {
      const desired = setInitiativeSection(exactMatch.description, section);
      if (desired !== exactMatch.description) exactMatch.description = desired;
      return { ...exactMatch };
    }

    // (b) id marker match
    const markerMatch = this.milestones.find((milestone) => readInitiativeIdFromSection(milestone.description) === initiative.id);
    if (markerMatch !== undefined) {
      markerMatch.title = desiredTitle;
      markerMatch.description = setInitiativeSection(markerMatch.description, section);
      return { ...markerMatch };
    }

    // (c) legacy: exact bare title with initiative section
    const legacyMatch = this.milestones.find((milestone) => milestone.title === initiative.title && /<!-- codepatrol:initiative:start -->/.test(milestone.description));
    if (legacyMatch !== undefined) {
      legacyMatch.title = desiredTitle;
      legacyMatch.description = setInitiativeSection(legacyMatch.description, section);
      return { ...legacyMatch };
    }

    // (d) create
    const created: GitHubMilestone = { number: this.nextMilestone++, title: desiredTitle, description: section, state: "open" };
    this.milestones.push(created);
    return { ...created };
  }

  async attachMilestone(_repository: string, issueNumber: number, milestoneNumber: number): Promise<void> {
    this.record("milestone.attach", { issueNumber, milestoneNumber });
    const issue = this.issue(issueNumber);
    if ((issue as GitHubIssue & { milestone?: number }).milestone === milestoneNumber) return;
    (issue as GitHubIssue & { milestone?: number }).milestone = milestoneNumber;
  }

  get milestonesPort(): GitHubMilestones {
    return {
      list: (repository) => this.listMilestones(repository),
      ensure: (repository, initiative, section) => this.ensureMilestone(repository, initiative, section),
      attachIssue: (repository, issueNumber, milestoneNumber) => this.attachMilestone(repository, issueNumber, milestoneNumber),
    };
  }

  async listComments(_repository: string, issueNumber: number): Promise<GitHubComment[]> {
    this.record("listComments", issueNumber);
    return this.commentsFor(issueNumber).map((comment) => ({ ...comment }));
  }

  async createComment(_repository: string, issueNumber: number, body: string): Promise<GitHubComment> {
    this.record("createComment", issueNumber);
    if (this.failNextCommentCreate) {
      this.failNextCommentCreate = false;
      throw new CodepatrolError("GH_ERROR", "Injected comment failure.");
    }
    const id = Math.max(0, ...this.comments.map((comment) => comment.id)) + 1;
    const comment = { id, issue: issueNumber, body, author: this.viewerLogin, authorAssociation: "OWNER", url: `https://github.test/comments/${id}` };
    this.comments.push(comment);
    if (this.failAfterNextCommentCreate) {
      this.failAfterNextCommentCreate = false;
      throw new CodepatrolError("GH_ERROR", "Injected post-create failure.");
    }
    const { issue: _issue, ...result } = comment;
    return result;
  }

  async editComment(_repository: string, comment: GitHubComment, body: string): Promise<GitHubComment> {
    this.record("editComment", comment.id);
    const stored = this.comments.find((candidate) => candidate.id === comment.id);
    if (stored === undefined) throw new Error(`No fake comment #${comment.id}.`);
    stored.body = body;
    const { issue: _issue, ...result } = stored;
    return { ...result };
  }

  async deleteComment(_repository: string, commentId: number): Promise<void> {
    this.record("deleteComment", commentId);
    const index = this.comments.findIndex((comment) => comment.id === commentId);
    if (index === -1) throw new Error(`No fake comment #${commentId}.`);
    this.comments.splice(index, 1);
  }

  async ensure(_repository: GitHubRepository): Promise<GitHubProject> {
    this.record("ensure", undefined);
    return this.project;
  }

  async reconcile(_project: GitHubProject, issue: GitHubIssue, status: ProjectStatus, outcome: ProjectOutcome): Promise<void> {
    this.record("reconcile", { issue: issue.number, status, outcome });
    this.statuses.set(issue.url, status);
    this.outcomes.set(issue.url, outcome);
  }
}

/** A `GitRemote` that records sync calls without touching a real remote. */
export class FakeRemote implements GitRemote {
  readonly calls: Array<{ remote: string; url: string }> = [];

  constructor(private readonly configured?: string) {}

  async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    return operation();
  }

  async resolveRepository(): Promise<string | undefined> {
    return this.configured;
  }

  async sync(remote: string, url: string, _policy: { isTerminal(workId: string): Promise<boolean>; cleanup?: boolean }, _scope?: { workId: string }): Promise<GitSyncResult> {
    this.calls.push({ remote, url });
    return { remote, remoteConfigured: this.calls.length === 1, refs: [] };
  }
}

export interface GhResponse {
  /** Matched against the joined argv, e.g. /^pr create/. */
  match: RegExp;
  stdout: string;
  code?: number;
}

/**
 * An argv-level `gh` fake, for adapter tests that inject `run` (see
 * `GhGitHubProjects`). Everything above the adapter uses {@link FakeGitHub}.
 */
export function ghScript(responses: readonly GhResponse[]): (args: string[]) => Promise<string> {
  return async (args: string[]) => {
    const line = args.join(" ");
    const response = responses.find((candidate) => candidate.match.test(line));
    if (response === undefined) throw new Error(`Unexpected gh invocation: ${line}`);
    if (response.code !== undefined && response.code !== 0) throw new CodepatrolError("GH_ERROR", `gh failed: ${response.stdout}`);
    return response.stdout;
  };
}
