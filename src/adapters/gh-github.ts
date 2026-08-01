import type { GitHubComment, GitHubIssue, GitHubIssueInput, GitHubIssueUpdate, GitHubIssues, GitHubLabelDefinition, GitHubLabelEnsureResult, GitHubLabels, GitHubRepository } from "../application/ports.js";
import { CodepatrolError } from "../core/errors.js";
import { executeGh, parseGhJson } from "./gh-command.js";

interface RawIssue {
  number?: unknown;
  title?: unknown;
  body?: unknown;
  state?: unknown;
  author?: { login?: unknown } | null;
  user?: { login?: unknown } | null;
  authorAssociation?: unknown;
  author_association?: unknown;
  url?: unknown;
  html_url?: unknown;
  pull_request?: unknown;
  labels?: unknown;
}

interface RawComment {
  id?: unknown;
  body?: unknown;
  user?: { login?: unknown } | null;
  author_association?: unknown;
  html_url?: unknown;
}

function parseLabels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const name = (item as { name?: unknown } | null)?.name;
    return typeof name === "string" && name !== "" ? [name] : [];
  });
}

function parseIssue(value: unknown): GitHubIssue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new CodepatrolError("GH_ERROR", "GitHub returned an invalid issue.");
  const issue = value as RawIssue;
  const state = String(issue.state).toLowerCase();
  const url = issue.html_url ?? issue.url;
  const author = issue.author ?? issue.user;
  const authorAssociation = issue.authorAssociation ?? issue.author_association;
  if (!Number.isSafeInteger(issue.number) || typeof issue.title !== "string" || (issue.body !== null && typeof issue.body !== "string") || (state !== "open" && state !== "closed") || typeof url !== "string") {
    throw new CodepatrolError("GH_ERROR", "GitHub returned an invalid issue.");
  }
  return {
    number: issue.number as number,
    title: issue.title,
    body: issue.body ?? "",
    state,
    author: typeof author?.login === "string" && author.login !== "" ? author.login : "github-user",
    ...(typeof authorAssociation === "string" ? { authorAssociation } : {}),
    url,
    labels: parseLabels(issue.labels),
  };
}

function parseComment(value: unknown): GitHubComment {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new CodepatrolError("GH_ERROR", "GitHub returned an invalid comment.");
  const comment = value as RawComment;
  if (!Number.isSafeInteger(comment.id) || (comment.body !== null && typeof comment.body !== "string") || typeof comment.html_url !== "string") throw new CodepatrolError("GH_ERROR", "GitHub returned an invalid comment.");
  return {
    id: comment.id as number,
    body: comment.body ?? "",
    author: typeof comment.user?.login === "string" && comment.user.login !== "" ? comment.user.login : "github-user",
    ...(typeof comment.author_association === "string" ? { authorAssociation: comment.author_association } : {}),
    url: comment.html_url,
  };
}

type GhRunner = (args: string[]) => Promise<string>;

async function viewIssue(repository: string, issueNumber: number, run: GhRunner): Promise<GitHubIssue> {
  // The REST endpoint carries authorAssociation and labels in one response, so
  // a single call is the source of truth for both list() and get().
  const raw = parseGhJson(await run(["api", `repos/${repository}/issues/${issueNumber}`]), "gh api issue");
  return parseIssue(raw);
}

export class GhGitHubIssues implements GitHubIssues {
  constructor(private readonly run: GhRunner = executeGh) {}

  async viewer(): Promise<string> {
    const raw = parseGhJson(await this.run(["api", "user"]), "gh api user");
    if (raw === null || typeof raw !== "object" || Array.isArray(raw) || typeof (raw as { login?: unknown }).login !== "string" || (raw as { login: string }).login === "") throw new CodepatrolError("GH_ERROR", "GitHub returned an invalid viewer.");
    return (raw as { login: string }).login;
  }

  async resolve(repository: string): Promise<GitHubRepository> {
    const raw = parseGhJson(await this.run(["repo", "view", repository, "--json", "nameWithOwner,url"]), "gh repo view");
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new CodepatrolError("GH_ERROR", "GitHub returned an invalid repository.");
    const value = raw as { nameWithOwner?: unknown; url?: unknown };
    if (typeof value.nameWithOwner !== "string" || value.nameWithOwner === "" || typeof value.url !== "string" || value.url === "") {
      throw new CodepatrolError("GH_ERROR", "GitHub returned an invalid repository.");
    }
    return { nameWithOwner: value.nameWithOwner, gitUrl: value.url };
  }

  async list(repository: string): Promise<GitHubIssue[]> {
    const raw = parseGhJson(await this.run(["api", "--paginate", "--slurp", `repos/${repository}/issues?state=all&per_page=100`]), "gh api");
    if (!Array.isArray(raw) || raw.some((page) => !Array.isArray(page))) throw new CodepatrolError("GH_ERROR", "GitHub returned an invalid issue list.");
    return raw.flatMap((page) => page as RawIssue[]).filter((issue) => issue.pull_request === undefined).map(parseIssue).sort((left, right) => left.number - right.number);
  }

  async get(repository: string, issueNumber: number): Promise<GitHubIssue> {
    return viewIssue(repository, issueNumber, this.run);
  }

  async create(repository: string, input: GitHubIssueInput): Promise<GitHubIssue> {
    const args = ["issue", "create", "--repo", repository, "--title", input.title, "--body", input.body];
    for (const label of input.labels ?? []) args.push("--label", label);
    const url = await this.run(args);
    const issueNumber = Number(/\/(\d+)\/?$/.exec(url)?.[1]);
    if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) throw new CodepatrolError("GH_ERROR", `gh issue create returned an invalid URL: ${url}.`);
    return viewIssue(repository, issueNumber, this.run);
  }

  async edit(repository: string, issue: GitHubIssue, input: GitHubIssueUpdate): Promise<GitHubIssue> {
    const args = ["issue", "edit", String(issue.number), "--repo", repository];
    if (input.title !== undefined) args.push("--title", input.title);
    if (input.body !== undefined) args.push("--body", input.body);
    for (const label of input.addLabels ?? []) args.push("--add-label", label);
    for (const label of input.removeLabels ?? []) args.push("--remove-label", label);
    if (args.length > 5) await this.run(args);
    if (input.state !== undefined && input.state !== issue.state) {
      await this.run(["issue", input.state === "open" ? "reopen" : "close", String(issue.number), "--repo", repository]);
    }
    return viewIssue(repository, issue.number, this.run);
  }

  async listComments(repository: string, issueNumber: number): Promise<GitHubComment[]> {
    const raw = parseGhJson(await this.run(["api", "--paginate", "--slurp", `repos/${repository}/issues/${issueNumber}/comments?per_page=100`]), "gh api comments");
    if (!Array.isArray(raw) || raw.some((page) => !Array.isArray(page))) throw new CodepatrolError("GH_ERROR", "GitHub returned an invalid comment list.");
    return raw.flatMap((page) => page as RawComment[]).map(parseComment).sort((left, right) => left.id - right.id);
  }

  async createComment(repository: string, issueNumber: number, body: string): Promise<GitHubComment> {
    const raw = await this.run(["api", "--method", "POST", `repos/${repository}/issues/${issueNumber}/comments`, "-f", `body=${body}`]);
    return parseComment(parseGhJson(raw, "gh api create comment"));
  }

  async editComment(repository: string, comment: GitHubComment, body: string): Promise<GitHubComment> {
    const raw = await this.run(["api", "--method", "PATCH", `repos/${repository}/issues/comments/${comment.id}`, "-f", `body=${body}`]);
    return parseComment(parseGhJson(raw, "gh api edit comment"));
  }

  async deleteComment(repository: string, commentId: number): Promise<void> {
    await this.run(["api", "--method", "DELETE", `repos/${repository}/issues/comments/${commentId}`]);
  }
}

export class GhGitHubLabels implements GitHubLabels {
  constructor(private readonly run: GhRunner = executeGh) {}

  async list(repository: string): Promise<GitHubLabelDefinition[]> {
    const raw = parseGhJson(await this.run(["label", "list", "--repo", repository, "--limit", "1000", "--json", "name,description,color"]), "gh label list");
    if (!Array.isArray(raw)) throw new CodepatrolError("GH_ERROR", "GitHub returned an invalid label list.");
    return raw.flatMap((item) => {
      const value = item as { name?: unknown; description?: unknown; color?: unknown };
      return typeof value.name === "string" && value.name !== ""
        ? [{ name: value.name, description: typeof value.description === "string" ? value.description : "", color: typeof value.color === "string" ? value.color : "" }]
        : [];
    });
  }

  /**
   * Idempotent by attempt: an existing label is success, and insufficient
   * permissions degrade to `unavailable` so Issue publication can continue.
   * Authentication and malformed-response failures stay explicit throws.
   */
  async ensure(repository: string, label: GitHubLabelDefinition): Promise<GitHubLabelEnsureResult> {
    try {
      await this.run(["label", "create", label.name, "--repo", repository, "--description", label.description, "--color", label.color]);
      return { status: "created", label };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/already exists/i.test(message)) return { status: "existing", label };
      if (/403|Forbidden/i.test(message)) return { status: "unavailable", label, warning: "Label management is not permitted for this repository." };
      throw error;
    }
  }
}
