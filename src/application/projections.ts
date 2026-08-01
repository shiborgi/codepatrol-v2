import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseRepositoryConfig, REPOSITORY_CONFIG_PATH, type RepositoryConfig } from "../core/repository-config.js";
import { defaultIssueClassification, type GitHubIssueClassificationConfig } from "../core/work-type-labels.js";

/**
 * Which GitHub projections a repository has turned on.
 *
 * Publication is a projection of local state, so what it may touch is a
 * repository decision rather than a consequence of a remote existing.
 */
export interface Projections {
  refs: boolean;
  issue: boolean;
  milestone: boolean;
  project: boolean;
}

export const ALL_PROJECTIONS: Projections = { refs: true, issue: true, milestone: true, project: true };
export const NO_PROJECTIONS: Projections = { refs: false, issue: false, milestone: false, project: false };

export function enabledProjections(config: RepositoryConfig): Projections {
  return {
    refs: config.github.refs.enabled,
    issue: config.github.issue.enabled,
    milestone: config.github.milestone.enabled,
    project: config.github.project.mode !== "disabled",
  };
}

export function projecting(projections: Projections): boolean {
  return projections.refs || projections.issue || projections.project;
}

/** Everything publication takes from repository configuration rather than from the remote. */
export interface PublicationSettings {
  projections: Projections;
  classification: GitHubIssueClassificationConfig;
}

/**
 * An uninitialized repository projects nothing.
 *
 * `init` is explicit, and so is publication: without configuration there is no
 * decision to project, and inventing one would write to GitHub on the strength
 * of a remote alone.
 */
export async function readPublicationSettings(workspace: string): Promise<PublicationSettings> {
  const raw = await readFile(path.join(workspace, REPOSITORY_CONFIG_PATH), "utf8")
    .catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
  if (raw === undefined) return { projections: NO_PROJECTIONS, classification: defaultIssueClassification() };
  const config = parseRepositoryConfig(raw);
  return { projections: enabledProjections(config), classification: config.github.issue.classification };
}

export async function readProjections(workspace: string): Promise<Projections> {
  return (await readPublicationSettings(workspace)).projections;
}
