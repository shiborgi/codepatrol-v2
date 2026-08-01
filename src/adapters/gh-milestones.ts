import type { GitHubMilestone, GitHubMilestones } from "../application/ports.js";
import { CodepatrolError } from "../core/errors.js";
import { setInitiativeSection } from "../application/publication/markers.js";
import { executeGh, parseGhJson } from "./gh-command.js";

type GhRunner = (args: string[]) => Promise<string>;

function parseMilestone(value: unknown): GitHubMilestone {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new CodepatrolError("GH_ERROR", "GitHub returned an invalid milestone.");
  const raw = value as { number?: unknown; title?: unknown; description?: unknown; state?: unknown };
  if (!Number.isSafeInteger(raw.number) || typeof raw.title !== "string" || raw.title === "" || (raw.state !== "open" && raw.state !== "closed")) {
    throw new CodepatrolError("GH_ERROR", "GitHub returned an invalid milestone.");
  }
  return { number: raw.number as number, title: raw.title, description: typeof raw.description === "string" ? raw.description : "", state: raw.state };
}

export class GhGitHubMilestones implements GitHubMilestones {
  constructor(private readonly run: GhRunner = executeGh) {}

  async list(repository: string): Promise<GitHubMilestone[]> {
    const raw = parseGhJson(await this.run(["api", "--paginate", "--slurp", `repos/${repository}/milestones?state=all&per_page=100`]), "gh api milestones");
    if (!Array.isArray(raw) || raw.some((page) => !Array.isArray(page))) throw new CodepatrolError("GH_ERROR", "GitHub returned an invalid milestone list.");
    return raw.flatMap((page) => (page as unknown[]).map(parseMilestone));
  }

  /**
   * Idempotent by title: the Milestone for an Initiative is found by name,
   * created once, and its managed section converged afterwards. Human text
   * outside the markers is preserved; an unchanged description is not edited.
   */
  async ensure(repository: string, title: string, section: string): Promise<GitHubMilestone> {
    const existing = (await this.list(repository)).find((milestone) => milestone.title === title);
    if (existing !== undefined) {
      const desired = setInitiativeSection(existing.description, section);
      if (desired === existing.description) return existing;
      const raw = parseGhJson(await this.run(["api", "-X", "PATCH", `repos/${repository}/milestones/${existing.number}`, "-f", `description=${desired}`]), "gh api milestone update");
      return parseMilestone(raw);
    }
    const raw = parseGhJson(await this.run(["api", `repos/${repository}/milestones`, "-f", `title=${title}`, "-f", `description=${section}`, "-f", "state=open"]), "gh api milestone create");
    return parseMilestone(raw);
  }

  /** Attaches an Issue when it is not already on the Milestone; a no-op otherwise. */
  async attachIssue(repository: string, issueNumber: number, milestoneNumber: number): Promise<void> {
    const raw = parseGhJson(await this.run(["api", `repos/${repository}/issues/${issueNumber}`]), "gh api issue");
    const current = (raw as { milestone?: { number?: unknown } | null }).milestone?.number;
    if (current === milestoneNumber) return;
    await this.run(["api", "-X", "PATCH", `repos/${repository}/issues/${issueNumber}`, "-F", `milestone=${milestoneNumber}`]);
  }
}
