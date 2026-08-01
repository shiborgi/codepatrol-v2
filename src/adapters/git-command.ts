import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { BRANCH_REF } from "../core/identifiers.js";
import { CodepatrolError } from "../core/errors.js";

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Suppresses repository hooks, so a hook can neither block nor rewrite a Codepatrol commit. */
export const WITHOUT_HOOKS = ["-c", `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`] as const;

/** Internal checkpoints never depend on the operator or CI runner identity. */
export const CODEPATROL_COMMIT_ENV: NodeJS.ProcessEnv = {
  GIT_AUTHOR_NAME: "Codepatrol",
  GIT_AUTHOR_EMAIL: "codepatrol@local.invalid",
  GIT_COMMITTER_NAME: "Codepatrol",
  GIT_COMMITTER_EMAIL: "codepatrol@local.invalid",
};

export interface GitOptions {
  /** Exit codes to accept instead of throwing. Defaults to `[0]`. */
  accept?: readonly number[];
  /** Extra environment, used for `GIT_INDEX_FILE` when building a tree off-checkout. */
  env?: NodeJS.ProcessEnv;
  /** Written to stdin, for `hash-object --stdin` and friends. */
  input?: string;
}

export async function executeGit(cwd: string, args: string[], options: readonly number[] | GitOptions = {}): Promise<GitResult> {
  const resolved: GitOptions = Array.isArray(options) ? { accept: options } : options as GitOptions;
  const acceptedCodes = resolved.accept ?? [0];
  const result = await new Promise<GitResult>((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      ...(resolved.env === undefined ? {} : { env: { ...process.env, ...resolved.env } }),
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      // A failed Git command may close stdin before consuming the supplied
      // input. Its exit status and stderr are the useful failure, not EPIPE.
      if (error.code !== "EPIPE") reject(error);
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({
      code: code ?? 1,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    }));
    child.stdin.end(resolved.input ?? "");
  });
  if (!acceptedCodes.includes(result.code)) {
    const detail = result.stderr.trim() || result.stdout.trim() || `git exited with ${result.code}`;
    throw new CodepatrolError("GIT_ERROR", `${args.slice(0, 2).join(" ")} failed: ${detail}`);
  }
  return result;
}

export function lines(value: string): string[] {
  return value.split(/\r?\n/).filter((line) => line !== "");
}

/**
 * Registers Codepatrol's runtime in `.git/info/exclude`.
 *
 * Worktrees live under `.codepatrol/runtime/`, so without this the tool's own
 * checkouts make the base dirty and it then refuses to integrate. Using
 * info/exclude rather than `.gitignore` keeps it out of the user's tree.
 */
export async function excludeRuntime(workspace: string): Promise<void> {
  const common = path.resolve(workspace, (await executeGit(workspace, ["rev-parse", "--git-common-dir"])).stdout.trim());
  const exclude = path.join(common, "info", "exclude");
  const rule = "/.codepatrol/runtime/";
  const existing = await readFile(exclude, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  if (lines(existing).includes(rule)) return;
  await mkdir(path.dirname(exclude), { recursive: true });
  await writeFile(exclude, `${existing}${existing === "" || existing.endsWith("\n") ? "" : "\n"}${rule}\n`, "utf8");
}

/** `owner/name` for a GitHub remote URL in any supported transport. */
export function githubRepository(url: string): string | undefined {
  return /^(?:git@github\.com:|ssh:\/\/git@github\.com\/|https?:\/\/github\.com\/)([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(url)?.[1]?.toLowerCase();
}

/**
 * Resolves the branch that accepted Works integrate into, from — in order — an
 * explicit base, the remote's default branch, the checked-out branch, then
 * `init.defaultBranch`. Nothing assumes `main`; a `master` or `trunk`
 * repository is as ordinary as any other.
 */
export async function resolveBaseRef(workspace: string, configured?: string): Promise<string> {
  if (configured !== undefined) {
    if (!BRANCH_REF.test(configured)) throw new CodepatrolError("INVALID_INPUT", `Base must be a refs/heads/* ref: ${configured}.`);
    return configured;
  }
  const remoteHead = await executeGit(workspace, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], [0, 1, 128]);
  const fromRemote = remoteHead.code === 0 ? /^refs\/remotes\/origin\/(.+)$/.exec(remoteHead.stdout.trim())?.[1] : undefined;
  const head = await executeGit(workspace, ["symbolic-ref", "--quiet", "--short", "HEAD"], [0, 1, 128]);
  const fromHead = head.code === 0 && head.stdout.trim() !== "" ? head.stdout.trim() : undefined;
  const configuredDefault = await executeGit(workspace, ["config", "--get", "init.defaultBranch"], [0, 1]);
  const fromConfig = configuredDefault.code === 0 && configuredDefault.stdout.trim() !== "" ? configuredDefault.stdout.trim() : undefined;
  const name = fromRemote ?? fromHead ?? fromConfig;
  if (name === undefined) throw new CodepatrolError("INVALID_INPUT", "Could not determine the base branch; pass an explicit base.");
  const ref = `refs/heads/${name}`;
  if (!BRANCH_REF.test(ref)) throw new CodepatrolError("INVALID_INPUT", `Resolved base is not a valid branch ref: ${ref}.`);
  return ref;
}
