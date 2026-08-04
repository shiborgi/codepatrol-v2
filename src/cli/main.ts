import process from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ChangeIntegration } from "../adapters/integration.js";
import { GitManifestStore } from "../adapters/manifest-store.js";
import { LocalGitPort } from "../adapters/git-port.js";
import { Worktrees, worktreeStoreHooks } from "../adapters/worktree.js";
import { LocalGitRemote } from "../adapters/local-git-remote.js";
import { GhGitHubIssues, GhGitHubLabels } from "../adapters/gh-github.js";
import { GhGitHubProjects } from "../adapters/gh-projects.js";
import { GhGitHubMilestones } from "../adapters/gh-milestones.js";
import { readPublicationSettings } from "../application/projections.js";
import { PublicationService } from "../application/publication.js";
import { SpecService } from "../application/spec-service.js";
import { InitiativeService } from "../application/initiative-service.js";
import { WorkService, type WorkServiceTelemetry } from "../application/work-service.js";
import { InitService } from "../application/init-service.js";
import { DoctorService } from "../application/doctor-service.js";
import { makeDefaultCollector } from "../application/telemetry.js";
import { CodepatrolError } from "../core/errors.js";
import { COMMANDS, helpText } from "./registry.js";
import { VERSION } from "./version.js";
import { listShippedSkills, HOST_CAPABILITIES } from "./commands/skill.js";

function extractWorkspace(args: string[]): { workspace: string; args: string[] } {
  const remaining = [...args];
  const index = remaining.indexOf("--workspace");
  if (index < 0) return { workspace: process.cwd(), args: remaining };
  const value = remaining[index + 1];
  if (value === undefined || value.startsWith("--")) throw new CodepatrolError("INVALID_ARGUMENT", "--workspace requires a path.", 2);
  if (remaining.indexOf("--workspace", index + 1) >= 0) throw new CodepatrolError("INVALID_ARGUMENT", "--workspace may only be set once.", 2);
  remaining.splice(index, 2);
  return { workspace: path.resolve(value), args: remaining };
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  if (argv.length === 0 || (argv.length === 1 && argv[0] === "--help")) {
    process.stdout.write(`${helpText()}\n`);
    return;
  }
  if (argv.length === 1 && argv[0] === "--version") {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  const extracted = extractWorkspace(argv);
  const [commandName, ...args] = extracted.args;
  const command = COMMANDS.find((candidate) => candidate.name === commandName);
  if (command === undefined) throw new CodepatrolError("INVALID_ARGUMENT", `Unknown command: ${commandName ?? "<missing>"}.`, 2);
  const worktrees = new Worktrees(extracted.workspace);
  const store = new GitManifestStore(extracted.workspace, worktreeStoreHooks(worktrees));
  const git = new LocalGitPort(extracted.workspace);
  const shippedSkillsDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../skills");
  const skillManifests = await listShippedSkills(shippedSkillsDirectory);
  const telemetry: WorkServiceTelemetry = {
    collector: makeDefaultCollector(shippedSkillsDirectory, skillManifests),
    skillManifests,
    hostCapabilities: [...HOST_CAPABILITIES],
  };
  const works = new WorkService(store, worktrees, new ChangeIntegration(extracted.workspace, worktrees), git, undefined, extracted.workspace, telemetry);
  const initiatives = new InitiativeService(store);
  const spec = new SpecService(store, worktrees);
  // Publication reads the repository's decision, not just its remote: a
  // projection the configuration disabled must never reach GitHub.
  const settings = await readPublicationSettings(extracted.workspace);
  const publication = new PublicationService(
    store,
    new LocalGitRemote(extracted.workspace),
    new GhGitHubIssues(),
    new GhGitHubLabels(),
    new GhGitHubProjects(),
    new GhGitHubMilestones(),
    settings.classification,
    settings.projections,
  );
  const result = await command.run({
    works,
    spec,
    initiatives,
    publication,
    initialization: new InitService(extracted.workspace),
    doctor: new DoctorService(extracted.workspace),
    workspace: extracted.workspace,
    setExitCode: (code) => { process.exitCode = code; },
  }, args);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error: unknown) => {
  const known = error instanceof CodepatrolError;
  // Recovery is part of the failure, not a nicety: a refused command has often
  // already committed local facts, and repeating it blindly is the real risk.
  const recovery = known ? error.recovery : undefined;
  process.stderr.write(`${JSON.stringify({
    error: known ? error.code : "UNEXPECTED_ERROR",
    message: error instanceof Error ? error.message : String(error),
    ...(recovery === undefined ? {} : { recovery }),
  })}\n`);
  process.exitCode = known ? error.exitCode : 1;
});
