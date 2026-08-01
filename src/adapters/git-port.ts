import type { GitPort, PathObject } from "../application/ports.js";
import { CodepatrolError } from "../core/errors.js";
import { GIT_HASH } from "../core/identifiers.js";
import { executeGit, lines } from "./git-command.js";
import { withGitRefLock } from "./git-lock.js";
import { changedPaths } from "./git-plumbing.js";

/** The `GitPort` over a real repository on disk. */
export class LocalGitPort implements GitPort {
  constructor(private readonly workspace: string) {}

  async resolveCommit(ref: string): Promise<string> {
    const commit = (await executeGit(this.workspace, ["rev-parse", ref])).stdout.trim();
    if (!GIT_HASH.test(commit)) throw new CodepatrolError("GIT_ERROR", `${ref} does not resolve to a commit.`);
    return commit;
  }

  async mergeBase(left: string, right: string): Promise<string> {
    const base = (await executeGit(this.workspace, ["merge-base", left, right])).stdout.trim();
    if (!GIT_HASH.test(base)) throw new CodepatrolError("GIT_ERROR", `No common ancestor for ${left} and ${right}.`);
    return base;
  }

  async resolvePath(commit: string, path: string): Promise<PathObject> {
    const found = await executeGit(this.workspace, ["rev-parse", "--verify", "--quiet", `${commit}:${path}`], { accept: [0, 1, 128] });
    const object = found.stdout.trim();
    if (found.code !== 0 || !GIT_HASH.test(object)) return { kind: "missing" };
    const type = (await executeGit(this.workspace, ["cat-file", "-t", object])).stdout.trim();
    return type === "blob" ? { kind: "blob", blob: object } : { kind: "other", type };
  }

  async readPath(commit: string, path: string): Promise<string | undefined> {
    const shown = await executeGit(this.workspace, ["show", `${commit}:${path}`], { accept: [0, 128] });
    return shown.code === 0 ? shown.stdout : undefined;
  }

  async changedPaths(from: string, to: string): Promise<string[]> {
    return changedPaths(this.workspace, from, to);
  }

  async findIntegrationCommit(ref: string, workId: string): Promise<string | undefined> {
    const found = lines((await executeGit(this.workspace, [
      "log", ref, "--format=%H", "--fixed-strings", `--grep=Codepatrol-Work: ${workId}`,
    ])).stdout);
    if (found.length > 1) throw new CodepatrolError("STATE_CORRUPT", `Multiple integration commits exist for ${workId}.`);
    const commit = found[0];
    return commit !== undefined && GIT_HASH.test(commit) ? commit : undefined;
  }

  async withLock<T>(name: string, operation: () => Promise<T>): Promise<T> {
    return withGitRefLock(this.workspace, name, operation);
  }
}
