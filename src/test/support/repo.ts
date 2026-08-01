import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Git runs with global and system configuration neutralized so a developer's
 * own `commit.gpgsign`, `core.hooksPath`, or `init.defaultBranch` cannot change
 * what the suite observes. Identity and timezone are fixed for the same reason.
 */
const GIT_ENV: NodeJS.ProcessEnv = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "Codepatrol Test",
  GIT_AUTHOR_EMAIL: "codepatrol@example.test",
  GIT_COMMITTER_NAME: "Codepatrol Test",
  GIT_COMMITTER_EMAIL: "codepatrol@example.test",
  GIT_AUTHOR_DATE: "2026-07-29T10:00:00+00:00",
  GIT_COMMITTER_DATE: "2026-07-29T10:00:00+00:00",
  GIT_TERMINAL_PROMPT: "0",
  TZ: "UTC",
};

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs git in `directory` with the isolated environment, tolerating failure. */
export async function tryGitIn(directory: string, ...args: string[]): Promise<GitResult> {
  try {
    const result = await run("git", args, { cwd: directory, env: { ...process.env, ...GIT_ENV } });
    return { code: 0, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, stdout: (failure.stdout ?? "").trim(), stderr: (failure.stderr ?? "").trim() };
  }
}

/** Runs git in `directory`, throwing with the captured stderr when it fails. */
export async function gitIn(directory: string, ...args: string[]): Promise<string> {
  const result = await tryGitIn(directory, ...args);
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed in ${directory}: ${result.stderr || result.stdout}`);
  return result.stdout;
}

export interface TestRepo {
  readonly root: string;
  readonly defaultBranch: string;
  git(...args: string[]): Promise<string>;
  tryGit(...args: string[]): Promise<GitResult>;
  gitIn(directory: string, ...args: string[]): Promise<string>;
  read(relative: string): Promise<string>;
  write(relative: string, contents: string): Promise<void>;
  commit(message: string, files?: string[]): Promise<string>;
  head(ref?: string): Promise<string>;
  refExists(ref: string): Promise<boolean>;
  commitCount(ref: string): Promise<number>;
  /** Every line of the commit message, so trailer assertions read naturally. */
  messageLines(commit: string): Promise<string[]>;
  /** Paths changed by a single commit. */
  changedFiles(commit: string): Promise<string[]>;
  /** File contents at a ref, or undefined when the path is absent there. */
  showFile(ref: string, relative: string): Promise<string | undefined>;
  cleanup(): Promise<void>;
}

export interface TestRepoOptions {
  /** Exercises non-`main` repositories without a second fixture. */
  defaultBranch?: string;
  /** Overrides the default `.gitignore` and `README.md` bootstrap files. */
  files?: Record<string, string>;
  /** Executable hooks written into `.git/hooks`, keyed by hook name. */
  hooks?: Record<string, string>;
  /** Directory to create the repository in; a temporary one is used otherwise. */
  at?: string;
  /** Explicit policy fixture; `null` deliberately creates a repository without one. */
  verifyPolicy?: unknown | null;
}

const DEFAULT_FILES: Record<string, string> = {
  ".gitignore": ".codepatrol/runtime/\n",
  "README.md": "# Fixture\n",
};

function repoApi(root: string, defaultBranch: string): TestRepo {
  return {
    root,
    defaultBranch,
    git: (...args) => gitIn(root, ...args),
    tryGit: (...args) => tryGitIn(root, ...args),
    gitIn,
    read: (relative) => readFile(path.join(root, relative), "utf8"),
    async write(relative, contents) {
      const absolute = path.join(root, relative);
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, contents, "utf8");
    },
    async commit(message, files) {
      if (files === undefined) await gitIn(root, "add", "-A");
      else await gitIn(root, "add", "--", ...files);
      await gitIn(root, "commit", "-m", message);
      return gitIn(root, "rev-parse", "HEAD");
    },
    head: (ref = "HEAD") => gitIn(root, "rev-parse", ref),
    async refExists(ref) {
      return (await tryGitIn(root, "rev-parse", "--verify", "--quiet", ref)).code === 0;
    },
    async commitCount(ref) {
      return Number(await gitIn(root, "rev-list", "--count", ref));
    },
    async messageLines(commit) {
      return (await gitIn(root, "show", "-s", "--format=%B", commit)).split(/\r?\n/).filter((line) => line !== "");
    },
    async changedFiles(commit) {
      return (await gitIn(root, "show", "--name-only", "--format=", commit)).split(/\r?\n/).filter((line) => line !== "");
    },
    async showFile(ref, relative) {
      const result = await tryGitIn(root, "show", `${ref}:${relative}`);
      return result.code === 0 ? result.stdout : undefined;
    },
    // Retries cover anything still holding a file: a fixture that cannot be
    // removed must not be reported as the test under it failing.
    cleanup: () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
  };
}

export async function createTestRepo(options: TestRepoOptions = {}): Promise<TestRepo> {
  const defaultBranch = options.defaultBranch ?? "main";
  const root = options.at ?? await mkdtemp(path.join(tmpdir(), "codepatrol-test-"));
  await mkdir(root, { recursive: true });
  await gitIn(root, "init", "-b", defaultBranch);
  // Git otherwise forks `gc --auto` in the background, which is still writing
  // into `.git/objects` when the fixture is torn down. On Linux that races the
  // recursive remove and surfaces as ENOTEMPTY — a teardown failure that reads
  // like a product failure.
  await gitIn(root, "config", "gc.auto", "0");
  await gitIn(root, "config", "gc.autoDetach", "false");
  await gitIn(root, "config", "maintenance.auto", "false");

  const repo = repoApi(root, defaultBranch);
  for (const [relative, contents] of Object.entries(options.files ?? DEFAULT_FILES)) await repo.write(relative, contents);
  if (options.verifyPolicy !== null) {
    const policy = options.verifyPolicy ?? { verify: { requiredCommands: [["node", "-e", "process.exit(0)"]] } };
    await repo.write(".codepatrol/policy.json", `${JSON.stringify(policy, null, 2)}\n`);
  }
  await repo.commit("bootstrap");
  // Hooks land after the bootstrap commit so a deliberately failing hook tests
  // what Codepatrol does, not whether the fixture can be built.
  for (const [name, script] of Object.entries(options.hooks ?? {})) {
    const hookPath = path.join(root, ".git", "hooks", name);
    await mkdir(path.dirname(hookPath), { recursive: true });
    await writeFile(hookPath, script, { encoding: "utf8", mode: 0o755 });
  }
  return repo;
}

/** A bare repository wired as `remote` on `repo`, for push and fetch assertions. */
export async function createBareRemote(repo: TestRepo, remote = "origin"): Promise<TestRepo> {
  const root = await mkdtemp(path.join(tmpdir(), "codepatrol-remote-"));
  await gitIn(root, "init", "--bare", "-b", repo.defaultBranch);
  await gitIn(root, "config", "gc.auto", "0");
  await gitIn(root, "config", "gc.autoDetach", "false");
  await repo.git("remote", "add", remote, root);
  return repoApi(root, repo.defaultBranch);
}
