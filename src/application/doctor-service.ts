import { access, readFile, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { executeGit, githubRepository } from "../adapters/git-command.js";
import { REPOSITORY_CONFIG_PATH, parseRepositoryConfig, type RepositoryConfig } from "../core/repository-config.js";
import { parseVerifyPolicy, VERIFY_POLICY_PATH } from "../core/verify-policy.js";

export interface DoctorCheck {
  id: string;
  status: "passed" | "warning" | "failed" | "skipped";
  message: string;
  next?: string;
}

export interface DoctorResult {
  status: "ready" | "failed";
  checks: DoctorCheck[];
}

async function executable(command: string, args: string[]): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const output: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => output.push(chunk));
    child.on("error", () => resolve({ code: 127, output: `${command} is not installed` }));
    child.on("close", (code) => resolve({ code: code ?? 1, output: Buffer.concat(output).toString("utf8").trim() }));
  });
}

export class DoctorService {
  constructor(private readonly workspace: string) {
    this.workspace = path.resolve(workspace);
  }

  async run(): Promise<DoctorResult> {
    const checks: DoctorCheck[] = [];
    const record = (check: DoctorCheck): void => { checks.push(check); };
    const nodeMajor = Number(process.versions.node.split(".")[0]);
    record(nodeMajor >= 20
      ? { id: "node-version", status: "passed", message: `Node.js ${process.versions.node}` }
      : { id: "node-version", status: "failed", message: `Node.js ${process.versions.node} is unsupported`, next: "Install Node.js 20 or newer" });

    const git = await executable("git", ["--version"]);
    const gitVersion = /git version (\d+)\.(\d+)/.exec(git.output);
    record(git.code === 0 && gitVersion !== null && (Number(gitVersion[1]) > 2 || Number(gitVersion[2]) >= 38)
      ? { id: "git-version", status: "passed", message: git.output }
      : { id: "git-version", status: "failed", message: git.output || "Git is unavailable", next: "Install Git 2.38 or newer" });

    let repositoryReady = false;
    try {
      const root = (await executeGit(this.workspace, ["rev-parse", "--show-toplevel"])).stdout.trim();
      repositoryReady = await realpath(root) === await realpath(this.workspace);
      record(repositoryReady
        ? { id: "repository", status: "passed", message: `Git repository root: ${root}` }
        : { id: "repository", status: "failed", message: `Workspace is inside repository ${root}`, next: `Run with --workspace ${root}` });
    } catch (error) {
      record({ id: "repository", status: "failed", message: error instanceof Error ? error.message : String(error), next: "Run codepatrol inside a Git repository" });
    }

    let config: RepositoryConfig | undefined;
    try {
      config = parseRepositoryConfig(await readFile(path.join(this.workspace, REPOSITORY_CONFIG_PATH), "utf8"));
      record({ id: "configuration", status: "passed", message: `${REPOSITORY_CONFIG_PATH} is valid` });
    } catch (error) {
      record({ id: "configuration", status: "failed", message: error instanceof Error ? error.message : String(error), next: "Run codepatrol init" });
    }
    try {
      parseVerifyPolicy(await readFile(path.join(this.workspace, VERIFY_POLICY_PATH), "utf8"));
      record({ id: "verify-policy", status: "passed", message: `${VERIFY_POLICY_PATH} is valid` });
    } catch (error) {
      record({ id: "verify-policy", status: "failed", message: error instanceof Error ? error.message : String(error), next: "Run codepatrol init or repair .codepatrol/policy.json" });
    }

    if (repositoryReady && config !== undefined) {
      const base = await executeGit(this.workspace, ["rev-parse", "--verify", `refs/heads/${config.baseBranch}^{commit}`], { accept: [0, 1, 128] });
      record(base.code === 0
        ? { id: "base-branch", status: "passed", message: `Base branch ${config.baseBranch} exists` }
        : { id: "base-branch", status: "failed", message: `Base branch ${config.baseBranch} does not exist`, next: "Run codepatrol init --replace with the correct --base" });
      const common = path.resolve(this.workspace, (await executeGit(this.workspace, ["rev-parse", "--git-common-dir"])).stdout.trim());
      try {
        await access(common, constants.W_OK);
        record({ id: "git-directory", status: "passed", message: `Git directory is writable: ${common}` });
      } catch {
        record({ id: "git-directory", status: "failed", message: `Git directory is not writable: ${common}`, next: "Restore write permission for the repository Git directory" });
      }
      const collision = await executeGit(this.workspace, ["show-ref", "--verify", "--quiet", "refs/heads/codepatrol"], { accept: [0, 1] });
      record(collision.code === 1
        ? { id: "ref-namespace", status: "passed", message: "Codepatrol ref namespaces are available" }
        : { id: "ref-namespace", status: "failed", message: "refs/heads/codepatrol blocks the Codepatrol branch namespace", next: "Rename or delete the conflicting branch after reviewing it" });
    } else {
      for (const id of ["base-branch", "git-directory", "ref-namespace"]) record({ id, status: "skipped", message: "Repository configuration is unavailable" });
    }

    if (config?.harness === "none" || config === undefined) {
      record({ id: "harness-adapter", status: "skipped", message: "No harness adapter is configured" });
      record({ id: "spec-skill", status: "skipped", message: "No harness adapter is configured" });
    } else {
      const adapter = `.${config.harness}/commands/codepatrol-spec.md`;
      const skill = `.${config.harness}/skills/codepatrol-spec/SKILL.md`;
      for (const [id, relative] of [["harness-adapter", adapter], ["spec-skill", skill]] as const) {
        const found = await access(path.join(this.workspace, relative)).then(() => true, () => false);
        record(found
          ? { id, status: "passed", message: `${relative} is installed` }
          : { id, status: "failed", message: `${relative} is missing`, next: `Run codepatrol init --harness ${config.harness} --replace` });
      }
    }

    const githubEnabled = config !== undefined && (config.github.refs.enabled || config.github.issue.enabled || config.github.project.mode !== "disabled");
    if (!githubEnabled) {
      for (const id of ["github-cli", "github-auth", "issue-permission", "github-issue-labels", "milestone-permission", "project-permission"]) {
        record({ id, status: "skipped", message: "GitHub projections are disabled" });
      }
    } else {
      const gh = await executable("gh", ["--version"]);
      record(gh.code === 0
        ? { id: "github-cli", status: "passed", message: gh.output.split("\n")[0] ?? "gh is installed" }
        : { id: "github-cli", status: "failed", message: gh.output, next: "Install GitHub CLI or disable GitHub projections" });
      const auth = gh.code === 0 ? await executable("gh", ["auth", "status"]) : { code: 127, output: "gh is unavailable" };
      record(auth.code === 0
        ? { id: "github-auth", status: "passed", message: "GitHub CLI is authenticated" }
        : { id: "github-auth", status: "failed", message: auth.output, next: "Run gh auth login" });
      const remote = repositoryReady ? await executeGit(this.workspace, ["remote", "get-url", "origin"], { accept: [0, 2, 128] }) : undefined;
      const repository = remote?.code === 0 ? githubRepository(remote.stdout.trim()) : undefined;
      for (const [id, enabled] of [["issue-permission", config?.github.issue.enabled]] as const) {
        if (!enabled) record({ id, status: "skipped", message: `${id.replace("-permission", "")} projection is disabled` });
        else if (auth.code !== 0 || repository === undefined) record({ id, status: "failed", message: "GitHub repository capability could not be resolved", next: "Configure an authenticated GitHub origin" });
        else {
          const probe = await executable("gh", ["api", `repos/${repository}`]);
          record(probe.code === 0
            ? { id, status: "passed", message: `${repository} is accessible` }
            : { id, status: "failed", message: probe.output, next: `Grant ${id.replace("-permission", "")} access to the GitHub token` });
        }
      }
      if (!config?.github.issue.enabled) record({ id: "github-issue-labels", status: "skipped", message: "issue projection is disabled" });
      else if (auth.code !== 0 || repository === undefined) record({ id: "github-issue-labels", status: "skipped", message: "GitHub repository capability could not be resolved" });
      else {
        const probe = await executable("gh", ["api", `repos/${repository}/labels?per_page=1`]);
        record(probe.code === 0
          ? { id: "github-issue-labels", status: "passed", message: "Managed Work type labels are available" }
          : { id: "github-issue-labels", status: "warning", message: "Issues can be created, but managed Work type labels cannot be created or updated", next: "Grant label permissions or rely on the managed Issue body" });
      }
      if (!config?.github.milestone.enabled) record({ id: "milestone-permission", status: "skipped", message: "Milestone projection is disabled" });
      else if (auth.code !== 0 || repository === undefined) record({ id: "milestone-permission", status: "failed", message: "GitHub repository capability could not be resolved", next: "Configure an authenticated GitHub origin" });
      else {
        const probe = await executable("gh", ["api", `repos/${repository}/milestones?per_page=1`]);
        record(probe.code === 0
          ? { id: "milestone-permission", status: "passed", message: "GitHub Milestones are accessible" }
          : { id: "milestone-permission", status: "warning", message: "Initiatives cannot be projected onto Milestones", next: "Grant Milestone access or disable Milestone projection" });
      }
      if (config?.github.project.mode === "disabled") record({ id: "project-permission", status: "skipped", message: "Project projection is disabled" });
      else {
        const probe = auth.code === 0 ? await executable("gh", ["project", "list", "--limit", "1", "--format", "json"]) : { code: 1, output: "GitHub authentication is unavailable" };
        record(probe.code === 0
          ? { id: "project-permission", status: "passed", message: "GitHub Projects are accessible" }
          : { id: "project-permission", status: "failed", message: probe.output, next: "Grant Projects read/write access or disable Project projection" });
      }
    }
    return { status: checks.some((check) => check.status === "failed") ? "failed" : "ready", checks };
  }
}
