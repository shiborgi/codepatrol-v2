import { access, mkdir, readFile, readdir, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { CodepatrolError } from "../core/errors.js";
import { GIT_HASH, WORK_ID } from "../core/identifiers.js";
import type { RepositoryCommit, RepositoryInspection } from "../core/types.js";
import { manifestPath, serializeManifest, workBranchRef } from "../core/work-manifest.js";
import { excludeRuntime, executeGit, lines, WITHOUT_HOOKS } from "./git-command.js";
import { branchCas, prepareCommitOnBranch, reconcileWorktreeIndex, updateRefsAtomically } from "./git-plumbing.js";
import { withGitRefLock } from "./git-lock.js";
import type { ManifestStoreHooks } from "./manifest-store.js";

export interface RegisteredWorktree {
  directory: string;
  branchRef?: string;
}

/**
 * The manifest-store hooks that keep a live checkout consistent with the
 * checkpoints Codepatrol commits behind its back.
 *
 * These belong next to the worktrees they manipulate rather than inside the
 * services that happen to trigger them, and they are passed to the store at
 * construction so nothing registers side effects after the fact.
 */
export function worktreeStoreHooks(worktrees: Worktrees): ManifestStoreHooks {
  return {
    onCheckpoint: async (workId, previous, next) => {
      await worktrees.reconcileIfPresent(workId, previous, next);
    },
    onRefreshPreflight: async (workId, manifest) => {
      const current = serializeManifest(manifest);
      await worktrees.reconcileIfPresent(workId, current, current);
      const inspection = await worktrees.inspect(workId, manifest.repository.baseRef, manifest.repository.createdFromCommit, manifest.repository.baselineCommit);
      if (!inspection.clean) throw new CodepatrolError("GIT_DIRTY", "Refresh requires a clean Change worktree.");
    },
    onRefreshed: async (workId, commit) => {
      await worktrees.realignIfPresent(workId, commit);
    },
  };
}

export function worktreePath(workId: string): string {
  return path.join(".codepatrol", "runtime", "worktrees", workId);
}

function parseCommits(raw: string): RepositoryCommit[] {
  return raw.split("\x1e").map((record) => record.replace(/^\r?\n|\r?\n$/g, "")).filter(Boolean).map((record) => {
    const [hash, author, authoredAt, subject] = record.split("\x1f");
    if (hash === undefined || author === undefined || authoredAt === undefined || subject === undefined) {
      throw new CodepatrolError("GIT_ERROR", "Git returned malformed commit metadata.");
    }
    return { hash, author, authoredAt, subject };
  });
}

/**
 * Worktrees are an operational convenience, never part of a Work's identity: a
 * Work lives in its branch and its manifest, and any worktree can be discarded
 * and recreated. Registry mutations take the repository lock because
 * `worktree add|remove|prune` all touch shared state under `$GIT_DIR`.
 */
export class Worktrees {
  constructor(readonly workspace: string) {
    this.workspace = path.resolve(workspace);
  }

  async registered(): Promise<RegisteredWorktree[]> {
    const records: RegisteredWorktree[] = [];
    let current: RegisteredWorktree | undefined;
    for (const line of (await executeGit(this.workspace, ["worktree", "list", "--porcelain"])).stdout.split(/\r?\n/)) {
      if (line.startsWith("worktree ")) {
        if (current !== undefined) records.push(current);
        current = { directory: line.slice("worktree ".length) };
      } else if (line.startsWith("branch ") && current !== undefined) {
        current.branchRef = line.slice("branch ".length);
      }
    }
    if (current !== undefined) records.push(current);
    return records;
  }

  async find(branchRef: string): Promise<string | undefined> {
    const found = (await this.registered()).find((item) => item.branchRef === branchRef);
    if (found === undefined) return undefined;
    return await access(found.directory).then(() => found.directory, () => undefined);
  }

  /**
   * Makes the Work's branch exist, cutting it from the base as it stands now
   * when absent. The manifest is projected into the base first, so the record
   * reaches the base and the branch inherits it; the caller records the cut as
   * the Work's baseline. Idempotent: an existing branch is left untouched.
   */
  async materialize(workId: string, baseRef: string, manifestContents: string): Promise<{ cutFromBase?: string }> {
    return withGitRefLock(this.workspace, "repository", () => this.materializeUnlocked(workId, baseRef, manifestContents));
  }

  private async materializeUnlocked(workId: string, baseRef: string, manifestContents: string): Promise<{ cutFromBase?: string }> {
    if (!WORK_ID.test(workId)) throw new CodepatrolError("INVALID_WORK_ID", `Invalid work id: ${workId}.`);
    const branchRef = workBranchRef(workId);
    const existing = (await executeGit(this.workspace, ["rev-parse", "--verify", "--quiet", `${branchRef}^{commit}`], { accept: [0, 1, 128] })).stdout.trim();
    if (GIT_HASH.test(existing)) return {};
    await excludeRuntime(this.workspace);
    const baseTip = (await executeGit(this.workspace, ["rev-parse", baseRef])).stdout.trim();
    if (!GIT_HASH.test(baseTip)) throw new CodepatrolError("GIT_BRANCH", `The base branch does not exist: ${baseRef}.`);
    const prepared = await prepareCommitOnBranch({
      workspace: this.workspace,
      branchRef: baseRef,
      parent: baseTip,
      expected: baseTip,
      writes: [{ path: manifestPath(workId), contents: manifestContents }],
      // No Codepatrol-Work trailer: integration finds the squash by that
      // trailer, and this projection commit must never be mistaken for it.
      subject: `codepatrol(${workId}): manifest projection`,
    });
    // A checked-out base moves through Git so the working tree follows the ref;
    // anywhere else the ref move alone is the whole change.
    const checkout = await this.baseCheckout(baseRef);
    if (prepared.changed) {
      if (checkout === undefined) await updateRefsAtomically(this.workspace, prepared.updates);
      else await this.advanceBase(baseRef, prepared.commit, checkout);
    }
    await branchCas(this.workspace, branchRef, prepared.commit);
    return { cutFromBase: prepared.commit };
  }

  /**
   * Materializes the checkout for a Work, creating it if absent. The manifest is
   * realigned in the index afterwards, because Codepatrol advances the manifest
   * through plumbing and the live index would otherwise report it as modified.
   */
  async attach(workId: string, manifestContents: string): Promise<string> {
    return withGitRefLock(this.workspace, "repository", () => this.attachUnlocked(workId, manifestContents));
  }

  private async attachUnlocked(workId: string, manifestContents: string): Promise<string> {
    if (!WORK_ID.test(workId)) throw new CodepatrolError("INVALID_WORK_ID", `Invalid work id: ${workId}.`);
    await excludeRuntime(this.workspace);
    const branchRef = workBranchRef(workId);
    const relative = worktreePath(workId);
    const absolute = path.join(this.workspace, relative);
    const registered = (await this.registered()).find((item) => item.branchRef === branchRef);
    const exists = await access(absolute).then(() => true, () => false);

    if (exists) {
      const head = await executeGit(absolute, ["symbolic-ref", "--quiet", "HEAD"], { accept: [0, 1, 128] });
      if (head.code === 0 && head.stdout.trim() === branchRef) {
        await reconcileWorktreeIndex(this.workspace, absolute, [{ path: manifestPath(workId), contents: manifestContents }]);
        return absolute;
      }
      const matches = registered !== undefined
        && await realpath(registered.directory).catch(() => path.resolve(registered.directory)) === await realpath(absolute).catch(() => path.resolve(absolute));
      if (!matches || (await readdir(absolute)).length > 0) {
        throw new CodepatrolError("GIT_WORKTREE", `Expected Work worktree is occupied by an unrecognized checkout: ${absolute}.`);
      }
      await rm(absolute, { recursive: true, force: true });
      await executeGit(this.workspace, ["worktree", "prune", "--expire", "now"]);
    } else if (registered !== undefined) {
      const stillThere = await access(registered.directory).then(() => true, () => false);
      if (stillThere) throw new CodepatrolError("GIT_WORKTREE", `Work branch is already checked out at ${registered.directory}.`);
      await executeGit(this.workspace, ["worktree", "prune", "--expire", "now"]);
    }

    await mkdir(path.dirname(absolute), { recursive: true });
    await executeGit(this.workspace, ["worktree", "add", absolute, branchRef.slice("refs/heads/".length)]);
    await reconcileWorktreeIndex(this.workspace, absolute, [{ path: manifestPath(workId), contents: manifestContents }]);
    return absolute;
  }

  /** Materializes the branch and the checkout together. */
  async ensure(workId: string, baseRef: string, manifestContents: string): Promise<{ directory: string; cutFromBase?: string }> {
    const materialized = await this.materialize(workId, baseRef, manifestContents);
    const directory = await this.attach(workId, manifestContents);
    return materialized.cutFromBase === undefined ? { directory } : { directory, cutFromBase: materialized.cutFromBase };
  }

  async reconcileIfPresent(workId: string, previous: string, next: string): Promise<string | undefined> {
    return withGitRefLock(this.workspace, "repository", async () => {
      const branchRef = workBranchRef(workId);
      const directory = await this.find(branchRef);
      if (directory === undefined) return undefined;
      const file = path.join(directory, manifestPath(workId));
      const current = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? "" : Promise.reject(error));
      if (current !== previous && current !== next) {
        throw new CodepatrolError("RESERVED_PATH", `The executor modified Codepatrol-owned manifest ${manifestPath(workId)}.`);
      }
      await reconcileWorktreeIndex(this.workspace, directory, [{ path: manifestPath(workId), contents: next }]);
      return directory;
    });
  }

  async realignIfPresent(workId: string, commit: string): Promise<string | undefined> {
    return withGitRefLock(this.workspace, "repository", async () => {
      const directory = await this.find(workBranchRef(workId));
      if (directory === undefined) return undefined;
      await executeGit(directory, [...WITHOUT_HOOKS, "reset", "--hard", commit]);
      return directory;
    });
  }

  async remove(workId: string): Promise<void> {
    return withGitRefLock(this.workspace, "repository", () => this.removeUnlocked(workId));
  }

  private async removeUnlocked(workId: string): Promise<void> {
    const absolute = path.join(this.workspace, worktreePath(workId));
    if (await access(absolute).then(() => true, () => false)) {
      await executeGit(this.workspace, ["worktree", "remove", "--force", absolute], { accept: [0, 1, 128] });
      await rm(absolute, { recursive: true, force: true });
    }
    await executeGit(this.workspace, ["worktree", "prune", "--expire", "now"]);
  }

  /**
   * Describes the Change: what the branch contains relative to the base. Reads
   * the branch itself, so it works whether or not a worktree exists. A Work
   * with no branch has no Change yet: the inspection is empty rather than an
   * error, because a backlog Work is a normal state, not a missing one.
   */
  async inspect(workId: string, baseRef: string, createdFromCommit: string | undefined, baselineCommit: string | undefined): Promise<RepositoryInspection> {
    const branchRef = workBranchRef(workId);
    const head = (await executeGit(this.workspace, ["rev-parse", "--verify", "--quiet", `${branchRef}^{commit}`], { accept: [0, 1, 128] })).stdout.trim();
    const targetCommit = (await executeGit(this.workspace, ["rev-parse", baseRef])).stdout.trim();
    if (!GIT_HASH.test(head)) {
      return {
        createdFromCommit: createdFromCommit ?? null,
        baselineCommit: baselineCommit ?? null,
        headCommit: null,
        targetCommit,
        baselineStale: false,
        clean: true,
        status: [],
        commits: [],
        changedFiles: [],
        diffStat: "",
      };
    }
    const directory = await this.find(branchRef);
    // The manifest is Codepatrol-owned: checkpoints realign it in the index
    // without touching the branch, so its resulting status entry is noise the
    // executor can neither cause nor prevent.
    const own = manifestPath(workId);
    const status = (directory === undefined ? [] : lines((await executeGit(directory, ["status", "--porcelain", "--untracked-files=all"])).stdout))
      .filter((line) => (line.slice(3).split(" -> ").at(-1) ?? "") !== own);
    const range = `${baselineCommit}..${head}`;
    return {
      createdFromCommit: createdFromCommit ?? null,
      baselineCommit: baselineCommit ?? null,
      headCommit: head,
      targetCommit,
      baselineStale: baselineCommit !== undefined && baselineCommit !== targetCommit,
      clean: status.length === 0,
      status,
      commits: parseCommits((await executeGit(this.workspace, ["log", "--reverse", "--format=%H%x1f%an%x1f%aI%x1f%s%x1e", range])).stdout),
      changedFiles: lines((await executeGit(this.workspace, ["diff", "--name-only", range])).stdout),
      diffStat: (await executeGit(this.workspace, ["diff", "--stat", range])).stdout.trim(),
    };
  }

  /**
   * The directory where the base is checked out, if anywhere, refusing early
   * when it has pending changes. Integration must know this before it computes
   * anything, because a dirty base checkout cannot receive the result.
   */
  async baseCheckout(baseRef: string): Promise<string | undefined> {
    const directory = await this.find(baseRef);
    if (directory === undefined) return undefined;
    const status = (await executeGit(directory, ["status", "--porcelain", "--untracked-files=all"])).stdout.trim();
    if (status !== "") throw new CodepatrolError("GIT_DIRTY", `The base branch is checked out with pending changes at ${directory}; commit or stash them first.`);
    return directory;
  }

  /**
   * Advances the base to `commit`.
   *
   * When the base is checked out, this must go through `merge --ff-only` in that
   * worktree: it moves the ref and the working tree together. Moving the ref on
   * its own would leave the checkout describing every integrated file as
   * deleted, and `--ff-only` refuses just as a compare-and-swap would if the
   * base moved underneath.
   */
  async advanceBase(_baseRef: string, commit: string, directory: string | undefined): Promise<void> {
    return withGitRefLock(this.workspace, "repository", async () => {
      if (directory === undefined) return;
      await executeGit(directory, [...WITHOUT_HOOKS, "merge", "--ff-only", commit]);
    });
  }
}
