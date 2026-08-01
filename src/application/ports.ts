import type { ProjectOutcome, ProjectStatus } from "../core/types.js";

export interface GitHubIssue {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  author: string;
  authorAssociation?: string;
  url: string;
  labels: string[];
}

export interface GitHubComment {
  id: number;
  body: string;
  author: string;
  authorAssociation?: string;
  url: string;
}

export interface GitHubRepository {
  nameWithOwner: string;
  gitUrl: string;
}

export interface GitHubProject {
  id: string;
  number: number;
  owner: string;
  title: string;
  statusFieldId: string;
  statusOptions: Readonly<Record<ProjectStatus, string>>;
  outcomeFieldId: string;
  outcomeOptions: Readonly<Record<ProjectOutcome, string>>;
}

export interface GitHubProjects {
  ensure(repository: GitHubRepository): Promise<GitHubProject>;
  reconcile(project: GitHubProject, issue: GitHubIssue, status: ProjectStatus, outcome: ProjectOutcome): Promise<void>;
}

export interface GitHubMilestone {
  number: number;
  title: string;
  description: string;
  state: "open" | "closed";
}

/**
 * An Initiative projects onto exactly one Milestone. `ensure` writes the
 * managed section into the description, preserving human text outside the
 * markers, and converges without edits on re-runs.
 */
export interface GitHubMilestones {
  list(repository: string): Promise<GitHubMilestone[]>;
  ensure(repository: string, title: string, section: string): Promise<GitHubMilestone>;
  attachIssue(repository: string, issueNumber: number, milestoneNumber: number): Promise<void>;
}

export interface GitHubIssueInput {
  title: string;
  body: string;
  labels?: string[];
}

export interface GitHubIssueUpdate {
  title?: string;
  body?: string;
  state?: "open" | "closed";
  addLabels?: string[];
  removeLabels?: string[];
}

export interface GitHubLabelDefinition {
  name: string;
  description: string;
  color: string;
}

export interface GitHubLabelEnsureResult {
  status: "existing" | "created" | "unavailable";
  label: GitHubLabelDefinition;
  warning?: string;
}

/**
 * Managed repository labels. A label failure is a projection degradation, not
 * an Issue failure: `ensure` reports `unavailable` instead of throwing so Issue
 * publication can continue with the managed body as the visible fallback.
 */
export interface GitHubLabels {
  list(repository: string): Promise<GitHubLabelDefinition[]>;
  ensure(repository: string, label: GitHubLabelDefinition): Promise<GitHubLabelEnsureResult>;
}

export interface GitHubIssues {
  viewer(): Promise<string>;
  resolve(repository: string): Promise<GitHubRepository>;
  list(repository: string): Promise<GitHubIssue[]>;
  get(repository: string, issueNumber: number): Promise<GitHubIssue>;
  create(repository: string, input: GitHubIssueInput): Promise<GitHubIssue>;
  edit(repository: string, issue: GitHubIssue, input: GitHubIssueUpdate): Promise<GitHubIssue>;
  listComments(repository: string, issueNumber: number): Promise<GitHubComment[]>;
  createComment(repository: string, issueNumber: number, body: string): Promise<GitHubComment>;
  editComment(repository: string, comment: GitHubComment, body: string): Promise<GitHubComment>;
  deleteComment(repository: string, commentId: number): Promise<void>;
}

/** What a repository-relative path resolves to inside one commit. */
export type PathObject =
  | { kind: "blob"; blob: string }
  | { kind: "other"; type: string }
  | { kind: "missing" };

/**
 * The local repository, as the application needs it.
 *
 * The application never spawns Git itself: it asks in terms of commits, paths,
 * and locks, and the adapter decides which plumbing answers that. This keeps
 * `WorkService` and `SpecService` testable against an in-memory repository and
 * mirrors how GitHub is already reached only through `GitHubIssues` and friends.
 */
export interface GitPort {
  /** The commit a ref points at. Throws when the ref does not resolve. */
  resolveCommit(ref: string): Promise<string>;
  /** The best common ancestor of two commits. */
  mergeBase(left: string, right: string): Promise<string>;
  /** What `path` is inside `commit`. */
  resolvePath(commit: string, path: string): Promise<PathObject>;
  /** The contents of `path` inside `commit`, or undefined when it is absent. */
  readPath(commit: string, path: string): Promise<string | undefined>;
  /** Every path touched by commits reachable from `to` but not from `from`. */
  changedPaths(from: string, to: string): Promise<string[]>;
  /** The single commit on `ref` carrying `Codepatrol-Work: <workId>`, if any. */
  findIntegrationCommit(ref: string, workId: string): Promise<string | undefined>;
  /** Serializes an operation against a named repository-wide lock. */
  withLock<T>(name: string, operation: () => Promise<T>): Promise<T>;
}

export interface GitRefSync {
  ref: string;
  commit: string;
  action: "pulled" | "pushed" | "deleted" | "unchanged";
}

export interface GitSyncResult {
  remote: string;
  remoteConfigured: boolean;
  refs: GitRefSync[];
}

export interface GitRemote {
  exclusive<T>(operation: () => Promise<T>): Promise<T>;
  /** GitHub repository `owner/name` from the configured remote, or `undefined` when it is missing or not a GitHub remote. */
  resolveRepository(remote: string): Promise<string | undefined>;
  /**
   * `isTerminal` is supplied by the application: the adapter applies the policy
   * to refs but never decides on its own which Works are finished.
   *
   * `cleanup` controls whether terminal Work branches may be deleted. The
   * coordinator publishes refs first, finalizes every enabled projection, and
   * only then allows cleanup — so a Project failure never strands a deleted
   * branch with an open Issue.
   */
  sync(remote: string, url: string, policy: { isTerminal(workId: string): Promise<boolean>; cleanup?: boolean }, scope?: { workId: string }): Promise<GitSyncResult>;
}
