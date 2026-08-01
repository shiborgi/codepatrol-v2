import type { GitHubIssue, GitHubProject, GitHubProjects, GitHubRepository } from "../application/ports.js";
import { CodepatrolError } from "../core/errors.js";
import { PROJECT_OUTCOMES, PROJECT_STATUSES, type ProjectOutcome, type ProjectStatus } from "../core/types.js";
import { executeGh, parseGhJson } from "./gh-command.js";

interface RawProject {
  id?: unknown;
  number?: unknown;
  title?: unknown;
  shortDescription?: unknown;
  closed?: unknown;
}

interface RawField {
  id?: unknown;
  name?: unknown;
  type?: unknown;
  options?: Array<{ id?: unknown; name?: unknown }>;
}

interface RawItem {
  id?: unknown;
  content?: { url?: unknown } | null;
}

interface ParsedProject {
  id: string;
  number: number;
  title: string;
  shortDescription?: unknown;
  closed: boolean;
}

const STATUS_FIELD = "Status";
const OUTCOME_FIELD = "Outcome";

const STATUS_COLORS: Readonly<Record<ProjectStatus, string>> = {
  Backlog: "GRAY",
  Plan: "BLUE",
  Review: "YELLOW",
  Build: "ORANGE",
  Verify: "PURPLE",
  Ship: "GREEN",
  Done: "GRAY",
};

const OUTCOME_COLORS: Readonly<Record<ProjectOutcome, string>> = {
  None: "GRAY",
  Accepted: "GREEN",
  "Rolled back": "RED",
  Superseded: "YELLOW",
  Cancelled: "GRAY",
};

function updateOptionsMutation(entries: ReadonlyArray<readonly [string, string]>): string {
  return `mutation($fieldId: ID!) {
  updateProjectV2Field(input: {fieldId: $fieldId, singleSelectOptions: [${entries.map(([name, color]) => `{name: "${name}", color: ${color}, description: ""}`).join(", ")}]}) {
    clientMutationId
  }
}`;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new CodepatrolError("GH_ERROR", `${label} returned invalid JSON.`);
  return value as Record<string, unknown>;
}

function projectTitle(repository: string): string {
  return `Codepatrol: ${repository}`;
}

function projectMarker(repository: string): string {
  return `Managed by Codepatrol for ${repository}.`;
}

function parseProject(value: unknown): ParsedProject {
  const project = object(value, "GitHub Project") as RawProject;
  if (typeof project.id !== "string" || project.id === "" || !Number.isSafeInteger(project.number) || (project.number as number) < 1 || typeof project.title !== "string" || project.title === "") throw new CodepatrolError("GH_ERROR", "GitHub returned an invalid Project.");
  if (project.closed !== undefined && typeof project.closed !== "boolean") throw new CodepatrolError("GH_ERROR", "GitHub returned an invalid Project state.");
  return { id: project.id, number: project.number as number, title: project.title, ...(project.shortDescription === undefined ? {} : { shortDescription: project.shortDescription }), closed: project.closed === true };
}

function parseProjects(value: unknown): ParsedProject[] {
  const result = object(value, "gh project list");
  if (!Array.isArray(result.projects)) throw new CodepatrolError("GH_ERROR", "GitHub returned an invalid Project list.");
  if (typeof result.totalCount === "number" && result.totalCount > result.projects.length) throw new CodepatrolError("SYNC_CONFLICT", "GitHub Project list exceeded the configured limit.");
  return result.projects.map(parseProject);
}

function parseFields(value: unknown): RawField[] {
  const result = object(value, "gh project field-list");
  if (!Array.isArray(result.fields)) throw new CodepatrolError("GH_ERROR", "GitHub returned an invalid Project field list.");
  if (typeof result.totalCount === "number" && result.totalCount > result.fields.length) throw new CodepatrolError("SYNC_CONFLICT", "GitHub Project field list exceeded the configured limit.");
  return result.fields.map((raw, index) => {
    const field = object(raw, `GitHub Project field ${index + 1}`) as RawField;
    if (typeof field.id !== "string" || field.id === "" || typeof field.name !== "string" || field.name === "" || typeof field.type !== "string") throw new CodepatrolError("GH_ERROR", "GitHub returned an invalid Project field.");
    if (field.options !== undefined && (!Array.isArray(field.options) || field.options.some((option) => option === null || typeof option !== "object" || typeof option.id !== "string" || option.id === "" || typeof option.name !== "string" || option.name === ""))) throw new CodepatrolError("GH_ERROR", "GitHub returned invalid Project field options.");
    return field;
  });
}

function parseItems(value: unknown): RawItem[] {
  const result = object(value, "gh project item-list");
  if (!Array.isArray(result.items)) throw new CodepatrolError("GH_ERROR", "GitHub returned an invalid Project item list.");
  if (typeof result.totalCount === "number" && result.totalCount > result.items.length) throw new CodepatrolError("SYNC_CONFLICT", "GitHub Project item list exceeded the configured limit.");
  return result.items.map((raw, index) => object(raw, `GitHub Project item ${index + 1}`) as RawItem);
}

function matchOptions<T extends string>(field: RawField, expected: readonly T[]): Readonly<Record<T, string>> | undefined {
  if (field.type !== "ProjectV2SingleSelectField" || !Array.isArray(field.options)) return undefined;
  const options = new Map(field.options.map((option) => [option.name, option.id]));
  if (options.size !== expected.length || expected.some((name) => typeof options.get(name) !== "string")) return undefined;
  return Object.fromEntries(expected.map((name) => [name, options.get(name) as string])) as unknown as Readonly<Record<T, string>>;
}

export class GhGitHubProjects implements GitHubProjects {
  private readonly itemCache = new Map<string, Map<string, string>>();

  constructor(private readonly run: (args: string[]) => Promise<string> = executeGh) {}

  private async ensureField(
    project: ParsedProject,
    owner: string,
    name: string,
    expected: readonly string[],
    colors: Readonly<Record<string, string>>,
  ): Promise<{ fieldId: string; options: Readonly<Record<string, string>> }> {
    let fields = parseFields(parseGhJson(await this.run(["project", "field-list", String(project.number), "--owner", owner, "--limit", "100", "--format", "json"]), "gh project field-list"));
    const matches = fields.filter((field) => field.name === name);
    if (matches.length > 1) throw new CodepatrolError("SYNC_CONFLICT", `GitHub Project ${project.title} contains multiple ${name} fields.`);
    let field = matches[0];
    let options = field === undefined ? undefined : matchOptions(field, expected);
    if (field !== undefined && options === undefined) {
      const items = parseItems(parseGhJson(await this.run(["project", "item-list", String(project.number), "--owner", owner, "--limit", "10000", "--format", "json"]), "gh project item-list"));
      if (items.length > 0 || typeof field.id !== "string" || field.type !== "ProjectV2SingleSelectField") throw new CodepatrolError("SYNC_CONFLICT", `GitHub Project ${project.title} has an incompatible ${name} field.`);
      await this.run(["api", "graphql", "-f", `query=${updateOptionsMutation(expected.map((entry) => [entry, colors[entry] ?? "GRAY"] as const))}`, "-f", `fieldId=${field.id}`]);
      fields = parseFields(parseGhJson(await this.run(["project", "field-list", String(project.number), "--owner", owner, "--limit", "100", "--format", "json"]), "gh project field-list"));
      field = fields.find((candidate) => candidate.name === name);
      options = field === undefined ? undefined : matchOptions(field, expected);
    }
    if (field === undefined) {
      await this.run(["project", "field-create", String(project.number), "--owner", owner, "--name", name, "--data-type", "SINGLE_SELECT", "--single-select-options", expected.join(","), "--format", "json"]);
      fields = parseFields(parseGhJson(await this.run(["project", "field-list", String(project.number), "--owner", owner, "--limit", "100", "--format", "json"]), "gh project field-list"));
      field = fields.find((candidate) => candidate.name === name);
      options = field === undefined ? undefined : matchOptions(field, expected);
    }
    if (field === undefined || typeof field.id !== "string" || options === undefined) throw new CodepatrolError("GH_ERROR", `GitHub Project ${project.title} ${name} field could not be configured.`);
    return { fieldId: field.id, options };
  }

  async ensure(repository: GitHubRepository): Promise<GitHubProject> {
    const owner = repository.nameWithOwner.split("/", 1)[0];
    if (owner === undefined || owner === "") throw new CodepatrolError("GH_ERROR", `Invalid repository identity: ${repository.nameWithOwner}.`);
    const title = projectTitle(repository.nameWithOwner);
    const marker = projectMarker(repository.nameWithOwner);
    const listed = parseProjects(parseGhJson(await this.run(["project", "list", "--owner", owner, "--closed", "--limit", "1000", "--format", "json"]), "gh project list"));
    const managed = listed.filter((candidate) => candidate.shortDescription === marker);
    if (managed.length > 1) throw new CodepatrolError("SYNC_CONFLICT", `Multiple GitHub Projects are managed for ${repository.nameWithOwner}.`);
    let project = managed[0];
    if (project === undefined) {
      project = parseProject(parseGhJson(await this.run(["project", "create", "--owner", owner, "--title", title, "--format", "json"]), "gh project create"));
      await this.run(["project", "edit", String(project.number), "--owner", owner, "--description", marker]);
      project = { ...project, shortDescription: marker };
    }
    if (project.closed) throw new CodepatrolError("SYNC_CONFLICT", `Managed GitHub Project ${project.title} is closed.`);
    await this.run(["project", "link", String(project.number), "--owner", owner, "--repo", repository.nameWithOwner]);

    const status = await this.ensureField(project, owner, STATUS_FIELD, PROJECT_STATUSES, STATUS_COLORS);
    const outcome = await this.ensureField(project, owner, OUTCOME_FIELD, PROJECT_OUTCOMES, OUTCOME_COLORS);
    return {
      id: project.id,
      number: project.number,
      owner,
      title: project.title,
      statusFieldId: status.fieldId,
      statusOptions: status.options as Readonly<Record<ProjectStatus, string>>,
      outcomeFieldId: outcome.fieldId,
      outcomeOptions: outcome.options as Readonly<Record<ProjectOutcome, string>>,
    };
  }

  async reconcile(project: GitHubProject, issue: GitHubIssue, status: ProjectStatus, outcome: ProjectOutcome): Promise<void> {
    let items = this.itemCache.get(project.id);
    if (items === undefined) {
      const listed = parseItems(parseGhJson(await this.run(["project", "item-list", String(project.number), "--owner", project.owner, "--limit", "10000", "--format", "json"]), "gh project item-list"));
      items = new Map<string, string>();
      for (const item of listed) {
        if (typeof item.id === "string" && typeof item.content?.url === "string") items.set(item.content.url, item.id);
      }
      this.itemCache.set(project.id, items);
    }
    let itemId = items.get(issue.url);
    if (itemId === undefined) {
      const added = object(parseGhJson(await this.run(["project", "item-add", String(project.number), "--owner", project.owner, "--url", issue.url, "--format", "json"]), "gh project item-add"), "gh project item-add");
      if (typeof added.id !== "string" || added.id === "") throw new CodepatrolError("GH_ERROR", "GitHub returned an invalid Project item.");
      itemId = added.id;
      items.set(issue.url, itemId);
    }
    await this.run(["project", "item-edit", "--id", itemId, "--project-id", project.id, "--field-id", project.statusFieldId, "--single-select-option-id", project.statusOptions[status]]);
    await this.run(["project", "item-edit", "--id", itemId, "--project-id", project.id, "--field-id", project.outcomeFieldId, "--single-select-option-id", project.outcomeOptions[outcome]]);
  }
}
