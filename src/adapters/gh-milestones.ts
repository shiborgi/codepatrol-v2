import type { GitHubMilestone, GitHubMilestones } from "../application/ports.js";
import { CodepatrolError } from "../core/errors.js";
import { INITIATIVE_SECTION_PRESENT, initiativeTitleOf, readInitiativeIdFromSection, setInitiativeSection } from "../application/publication/markers.js";
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
  async ensure(repository: string, initiative: { id: string; title: string }, section: string): Promise<GitHubMilestone> {
    const desiredTitle = initiativeTitleOf(initiative);
    const milestones = await this.list(repository);

    // (a) exact new title → converge description only
    const exactMatch = milestones.find((milestone) => milestone.title === desiredTitle);
    if (exactMatch !== undefined) return this.converge(repository, exactMatch, section);

    // (b) id marker match → retitle + converge
    const markerMatch = milestones.find((milestone) => readInitiativeIdFromSection(milestone.description) === initiative.id);
    if (markerMatch !== undefined) {
      const raw = parseGhJson(await this.run(["api", "-X", "PATCH", `repos/${repository}/milestones/${markerMatch.number}`, "-f", `title=${desiredTitle}`, "-f", `description=${setInitiativeSection(markerMatch.description, section)}`]), "gh api milestone update");
      return parseMilestone(raw);
    }

    // (c) legacy: exact bare title AND an initiative section present → retitle + converge
    const legacyMatch = milestones.find((milestone) => milestone.title === initiative.title && INITIATIVE_SECTION_PRESENT.test(milestone.description));
    if (legacyMatch !== undefined) {
      const raw = parseGhJson(await this.run(["api", "-X", "PATCH", `repos/${repository}/milestones/${legacyMatch.number}`, "-f", `title=${desiredTitle}`, "-f", `description=${setInitiativeSection(legacyMatch.description, section)}`]), "gh api milestone update");
      return parseMilestone(raw);
    }

    // (d) create
    const raw = parseGhJson(await this.run(["api", `repos/${repository}/milestones`, "-f", `title=${desiredTitle}`, "-f", `description=${section}`, "-f", "state=open"]), "gh api milestone create");
    return parseMilestone(raw);
  }

  private async converge(repository: string, milestone: GitHubMilestone, section: string): Promise<GitHubMilestone> {
    const desired = setInitiativeSection(milestone.description, section);
    if (desired === milestone.description) return milestone;
    const raw = parseGhJson(await this.run(["api", "-X", "PATCH", `repos/${repository}/milestones/${milestone.number}`, "-f", `description=${desired}`]), "gh api milestone update");
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
