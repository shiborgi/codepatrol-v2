import { access, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { executeGh } from "../adapters/gh-command.js";
import { GhGitHubLabels } from "../adapters/gh-github.js";
import { executeGit, excludeRuntime, githubRepository, resolveBaseRef } from "../adapters/git-command.js";
import { CodepatrolError } from "../core/errors.js";
import { REPOSITORY_CONFIG_PATH, REPOSITORY_CONFIG_SCHEMA_VERSION, serializeRepositoryConfig, type Harness, type ProjectConfig, type RepositoryConfig } from "../core/repository-config.js";
import { ISSUE_TYPES } from "../core/types.js";
import { parseVerifyPolicy, serializeVerifyPolicy, VERIFY_POLICY_PATH, type VerifyPolicy } from "../core/verify-policy.js";
import { defaultIssueClassification, resolveWorkTypeLabel } from "../core/work-type-labels.js";

export interface InitInput {
  baseBranch?: string;
  harness: Harness;
  requiredCommands?: string[][];
  github: boolean;
  project: ProjectConfig;
  replace: boolean;
}

export interface InitResult {
  status: "initialized" | "unchanged";
  baseBranch: string;
  files: Array<{ path: string; action: "created" | "replaced" | "unchanged" }>;
  labels?: Array<{ name: string; status: "created" | "existing" | "unavailable" }>;
  nextCommand: string;
}

const ADAPTERS: Record<Exclude<Harness, "none">, string> = {
  opencode: ".opencode/commands/codepatrol-spec.md",
  claude: ".claude/commands/codepatrol-spec.md",
};

async function packagedSpecSkill(): Promise<string> {
  const module = path.dirname(fileURLToPath(import.meta.url));
  return readFile(path.resolve(module, "../../skills/codepatrol-spec/SKILL.md"), "utf8");
}

function adapterContents(_harness: Exclude<Harness, "none">): string {
  return `---\ndescription: Propose and apply Codepatrol Work graph changes through Spec\n---\n\nLoad the \`codepatrol-spec\` skill and follow it exactly. Pass the repository root with \`--workspace\`.\n`;
}

export class InitService {
  constructor(private readonly workspace: string) {
    this.workspace = path.resolve(workspace);
  }

  private async inferredCommands(): Promise<string[][] | undefined> {
    const raw = await readFile(path.join(this.workspace, "package.json"), "utf8").catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
    if (raw === undefined) return undefined;
    try {
      const document = JSON.parse(raw) as { scripts?: Record<string, unknown> };
      return typeof document.scripts?.verify === "string" ? [["npm", "run", "verify"]] : undefined;
    } catch {
      return undefined;
    }
  }

  async run(input: InitInput): Promise<InitResult> {
    const root = (await executeGit(this.workspace, ["rev-parse", "--show-toplevel"])).stdout.trim();
    if (await realpath(root) !== await realpath(this.workspace)) throw new CodepatrolError("INVALID_REPOSITORY", `Initialize the repository root instead: ${root}.`);
    await executeGit(this.workspace, ["rev-parse", "--verify", "HEAD^{commit}"]);
    const configured = input.baseBranch === undefined
      ? undefined
      : input.baseBranch.startsWith("refs/heads/") ? input.baseBranch : `refs/heads/${input.baseBranch}`;
    const baseRef = await resolveBaseRef(this.workspace, configured);
    await executeGit(this.workspace, ["rev-parse", "--verify", `${baseRef}^{commit}`]);
    const requiredCommands = input.requiredCommands ?? await this.inferredCommands();
    if (requiredCommands === undefined) {
      throw new CodepatrolError("VERIFY_POLICY_REQUIRED", "Initialization needs --verify-commands because no package verify script was found.", 1, {
        expected: "a JSON array of command argument arrays",
        nextCommand: "codepatrol init --verify-commands '[[\"npm\",\"test\"]]'",
      });
    }
    const policy: VerifyPolicy = parseVerifyPolicy(serializeVerifyPolicy({ requiredCommands, persistOutputExcerpt: false }));
    if (input.project.mode !== "disabled" && !input.github) throw new CodepatrolError("INVALID_INPUT", "Project projection requires --github.");
    const config: RepositoryConfig = {
      schemaVersion: REPOSITORY_CONFIG_SCHEMA_VERSION,
      baseBranch: baseRef.slice("refs/heads/".length),
      harness: input.harness,
      github: {
        refs: { enabled: input.github },
        issue: { enabled: input.github, classification: defaultIssueClassification() },
        milestone: { enabled: input.github },
        project: input.project,
      },
    };
    const desired = new Map<string, string>([
      [REPOSITORY_CONFIG_PATH, serializeRepositoryConfig(config)],
      [VERIFY_POLICY_PATH, `${JSON.stringify({ verify: policy }, null, 2)}\n`],
    ]);
    if (input.harness !== "none") {
      const skill = await packagedSpecSkill();
      desired.set(ADAPTERS[input.harness], adapterContents(input.harness));
      desired.set(`.${input.harness}/skills/codepatrol-spec/SKILL.md`, skill.endsWith("\n") ? skill : `${skill}\n`);
    }

    const existing = new Map<string, string | undefined>();
    for (const relative of desired.keys()) {
      const current = await readFile(path.join(this.workspace, relative), "utf8").catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
      existing.set(relative, current);
      if (current !== undefined && current !== desired.get(relative) && !input.replace) {
        throw new CodepatrolError("INIT_CONFLICT", `Initialization would overwrite ${relative}; rerun with --replace after reviewing it.`);
      }
    }

    const files: InitResult["files"] = [];
    const temporary: string[] = [];
    try {
      for (const [relative, contents] of desired) {
        const current = existing.get(relative);
        if (current === contents) {
          files.push({ path: relative, action: "unchanged" });
          continue;
        }
        const target = path.join(this.workspace, relative);
        await mkdir(path.dirname(target), { recursive: true });
        await access(path.dirname(target), constants.W_OK);
        const temp = `${target}.codepatrol-${process.pid}.tmp`;
        temporary.push(temp);
        await writeFile(temp, contents, { encoding: "utf8", flag: "wx" });
        await rename(temp, target);
        temporary.splice(temporary.indexOf(temp), 1);
        files.push({ path: relative, action: current === undefined ? "created" : "replaced" });
      }
    } finally {
      await Promise.all(temporary.map((file) => rm(file, { force: true })));
    }
    await excludeRuntime(this.workspace);
    const labels = input.github ? await this.ensureManagedLabels(config) : undefined;
    return {
      status: files.every((file) => file.action === "unchanged") ? "unchanged" : "initialized",
      baseBranch: config.baseBranch,
      files,
      ...(labels === undefined ? {} : { labels }),
      nextCommand: "codepatrol doctor",
    };
  }

  /**
   * Best effort only: initialization must succeed in local-only mode, and a
   * label that cannot be created now is recreated by the first sync instead.
   */
  private async ensureManagedLabels(config: RepositoryConfig): Promise<Array<{ name: string; status: "created" | "existing" | "unavailable" }> | undefined> {
    const remote = await executeGit(this.workspace, ["remote", "get-url", "origin"], { accept: [0, 2, 128] });
    const repository = remote.code === 0 ? githubRepository(remote.stdout.trim()) : undefined;
    if (repository === undefined) return undefined;
    const labelsPort = new GhGitHubLabels(executeGh);
    const results: Array<{ name: string; status: "created" | "existing" | "unavailable" }> = [];
    for (const type of ISSUE_TYPES) {
      const definition = resolveWorkTypeLabel(type, config.github.issue.classification);
      try {
        const ensured = await labelsPort.ensure(repository, definition);
        results.push({ name: definition.name, status: ensured.status });
      } catch {
        results.push({ name: definition.name, status: "unavailable" });
      }
    }
    return results;
  }
}
