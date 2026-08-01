import { realpath } from "node:fs/promises";
import path from "node:path";
import type { GitRefSync, GitRemote, GitSyncResult } from "../application/ports.js";
import { CodepatrolError } from "../core/errors.js";
import { GIT_HASH, WORK_ID } from "../core/identifiers.js";
import { manifestPath, parseWorkManifest, type WorkManifest } from "../core/work-manifest.js";
import { executeGit, githubRepository, lines, resolveBaseRef, WITHOUT_HOOKS } from "./git-command.js";
import { withGitRefLock } from "./git-lock.js";
import { updateRefsAtomically } from "./git-plumbing.js";

interface Worktree {
  directory: string;
  branchRef?: string;
}

const REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export class LocalGitRemote implements GitRemote {
  readonly workspace: string;
  private resolvedBase: string | undefined;

  constructor(workspace: string, private readonly configuredBase?: string) {
    this.workspace = path.resolve(workspace);
  }

  /** The branch accepted Works integrate into, resolved once per instance. */
  private async baseRef(): Promise<string> {
    this.resolvedBase ??= await resolveBaseRef(this.workspace, this.configuredBase);
    return this.resolvedBase;
  }

  private async assertRepository(): Promise<void> {
    const root = (await executeGit(this.workspace, ["rev-parse", "--show-toplevel"])).stdout.trim();
    const [actual, expected] = await Promise.all([realpath(root), realpath(this.workspace)]);
    if (actual !== expected) throw new CodepatrolError("GIT_WORKSPACE", `Workspace must be the Git repository root: ${root}.`);
  }

  private async configureRemote(remote: string, url: string): Promise<boolean> {
    const existing = await executeGit(this.workspace, ["remote", "get-url", remote], [0, 2, 128]);
    if (existing.code !== 0) {
      await executeGit(this.workspace, ["remote", "add", remote, url]);
      return true;
    }
    const fetchUrls = lines((await executeGit(this.workspace, ["remote", "get-url", "--all", remote])).stdout);
    const pushUrls = lines((await executeGit(this.workspace, ["remote", "get-url", "--push", "--all", remote])).stdout);
    for (const actual of [...fetchUrls, ...pushUrls]) {
      const expectedRepository = githubRepository(url);
      const actualRepository = githubRepository(actual);
      const matches = expectedRepository === undefined && actualRepository === undefined ? actual === url : expectedRepository !== undefined && expectedRepository === actualRepository;
      if (!matches) throw new CodepatrolError("SYNC_CONFLICT", `Remote ${remote} URL ${actual} does not match ${url}.`);
    }
    return false;
  }

  async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    await this.assertRepository();
    return withGitRefLock(this.workspace, "sync", operation);
  }

  async resolveRepository(remote: string): Promise<string | undefined> {
    if (!REMOTE_NAME.test(remote)) throw new CodepatrolError("INVALID_INPUT", `Invalid Git remote name: ${remote}.`);
    const existing = await executeGit(this.workspace, ["remote", "get-url", remote], [0, 2, 128]);
    if (existing.code !== 0) return undefined;
    const repositories = new Set(lines(existing.stdout).map(githubRepository));
    if (repositories.size !== 1) return undefined;
    return [...repositories][0];
  }

  private matchesScope(ref: string, baseRef: string, workId?: string): boolean {
    return workId === undefined
      || ref === baseRef
      || ref === `refs/heads/codepatrol/work/${workId}`
      || ref === `refs/heads/codepatrol/archive/${workId}`
      || ref.startsWith(`refs/heads/codepatrol/recovery/${workId}/`)
      || ref === `refs/codepatrol/manifest/${workId}`;
  }

  private async localRefs(baseRef: string, workId?: string): Promise<Map<string, string>> {
    const raw = await executeGit(this.workspace, ["for-each-ref", "--format=%(refname) %(objectname)", baseRef, "refs/heads/codepatrol/", "refs/codepatrol/manifest/"]);
    return new Map(lines(raw.stdout).map((line) => {
      const separator = line.lastIndexOf(" ");
      return [line.slice(0, separator), line.slice(separator + 1)] as const;
    }).filter(([ref]) => this.matchesScope(ref, baseRef, workId)));
  }

  private async remoteRefs(remote: string, baseRef: string, workId?: string): Promise<Map<string, string>> {
    const raw = await executeGit(this.workspace, ["ls-remote", remote, baseRef, "refs/heads/codepatrol/*", "refs/codepatrol/manifest/*"]);
    const refs = new Map<string, string>();
    for (const line of lines(raw.stdout)) {
      const [hash, ref] = line.split(/\s+/);
      if (hash === undefined || ref === undefined || !GIT_HASH.test(hash) || (!ref.startsWith("refs/heads/codepatrol/") && !ref.startsWith("refs/codepatrol/manifest/") && ref !== baseRef)) {
        throw new CodepatrolError("GIT_ERROR", "Git returned malformed remote refs.");
      }
      if (this.matchesScope(ref, baseRef, workId)) refs.set(ref, hash);
    }
    return refs;
  }

  private async fetchRefs(remote: string, refs: ReadonlyMap<string, string>): Promise<void> {
    if (refs.size === 0) return;
    const refspecs = [...refs.keys()].map((ref) => `+${ref}:refs/codepatrol/remotes/${remote}/${ref.slice("refs/".length)}`);
    await executeGit(this.workspace, ["fetch", "--no-tags", remote, ...refspecs]);
  }

  private async worktrees(): Promise<Worktree[]> {
    const worktrees: Worktree[] = [];
    let current: Worktree | undefined;
    for (const line of (await executeGit(this.workspace, ["worktree", "list", "--porcelain"])).stdout.split(/\r?\n/)) {
      if (line.startsWith("worktree ")) {
        if (current !== undefined) worktrees.push(current);
        current = { directory: line.slice("worktree ".length) };
      } else if (line.startsWith("branch ") && current !== undefined) current.branchRef = line.slice("branch ".length);
    }
    if (current !== undefined) worktrees.push(current);
    return worktrees;
  }

  private async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    return (await executeGit(this.workspace, ["merge-base", "--is-ancestor", ancestor, descendant], [0, 1])).code === 0;
  }

  private activeWorkId(ref: string): string | undefined {
    const workId = /^refs\/heads\/codepatrol\/work\/([^/]+)$/.exec(ref)?.[1];
    return workId !== undefined && WORK_ID.test(workId) ? workId : undefined;
  }

  private workIdForRef(ref: string): string | undefined {
    const workId = /^refs\/(?:heads\/codepatrol\/(?:work|archive|recovery)\/|codepatrol\/manifest\/)([^/]+)/.exec(ref)?.[1];
    return workId !== undefined && WORK_ID.test(workId) ? workId : undefined;
  }

  /**
   * Whether a Work is terminal, read from its manifest ref: the ref is the
   * authority on the Work, so a work branch may be cleaned up exactly when the
   * manifest it belongs to says the Work is done.
   */
  private async isTerminalWork(refs: ReadonlyMap<string, string>, workId: string): Promise<boolean> {
    const manifestCommit = refs.get(`refs/codepatrol/manifest/${workId}`);
    if (manifestCommit === undefined) return false;
    const stored = await executeGit(this.workspace, ["show", `${manifestCommit}:${manifestPath(workId)}`], { accept: [0, 128] });
    if (stored.code !== 0) return false;
    let manifest: WorkManifest;
    try {
      manifest = parseWorkManifest(JSON.parse(stored.stdout) as unknown, workId);
    } catch (error) {
      if (error instanceof SyntaxError) return false;
      throw error;
    }
    return manifest.workflow.state === "terminal" && manifest.completion !== null;
  }

  async sync(remote: string, url: string, policy: { isTerminal(workId: string): Promise<boolean>; cleanup?: boolean }, scope?: { workId: string }): Promise<GitSyncResult> {
    if (!REMOTE_NAME.test(remote)) throw new CodepatrolError("INVALID_INPUT", `Invalid Git remote name: ${remote}.`);
    if (url.trim() === "") throw new CodepatrolError("INVALID_INPUT", "Git remote URL is required.");
    await this.assertRepository();
    return withGitRefLock(this.workspace, "repository", async () => {
      const baseRef = await this.baseRef();
      const remoteConfigured = await this.configureRemote(remote, url);
      const localRefs = await this.localRefs(baseRef, scope?.workId);
      const remoteRefs = await this.remoteRefs(remote, baseRef, scope?.workId);
      await this.fetchRefs(remote, remoteRefs);
      if (!localRefs.has(baseRef)) throw new CodepatrolError("GIT_BRANCH", `The local ${baseRef.slice("refs/heads/".length)} branch is required.`);

      const incoming: Array<{ ref: string; hash: string }> = [];
      const outgoing: Array<{ ref: string; hash: string }> = [];
      const unchanged: GitRefSync[] = [];
      const pulled: GitRefSync[] = [];
      const terminalActiveRefs = new Set<string>();
      const incompleteTerminalWorks = new Set<string>();
      const deletions: string[] = [];
      const localDeletions: Array<{ ref: string; hash: string }> = [];
      const worktrees = await this.worktrees();
      const localBase = localRefs.get(baseRef) as string;
      const remoteBase = remoteRefs.get(baseRef);
      if (remoteBase === undefined) outgoing.push({ ref: baseRef, hash: localBase });
      else if (localBase === remoteBase) unchanged.push({ ref: baseRef, commit: localBase, action: "unchanged" });
      else if (await this.isAncestor(remoteBase, localBase)) outgoing.push({ ref: baseRef, hash: localBase });
      else if (await this.isAncestor(localBase, remoteBase)) {
        incoming.push({ ref: baseRef, hash: remoteBase });
      } else throw new CodepatrolError("SYNC_CONFLICT", `Local and remote histories diverged at ${baseRef}.`);

      const allRefs = [...new Set([...localRefs.keys(), ...remoteRefs.keys()])].filter((ref) => ref !== baseRef).sort();
      for (const ref of allRefs) {
        const activeWorkId = this.activeWorkId(ref);
        const terminal = activeWorkId !== undefined
          && (await this.isTerminalWork(localRefs, activeWorkId) || await this.isTerminalWork(remoteRefs, activeWorkId));
        // The branch may be cleaned up only once the archive exists somewhere:
        // a terminal Work whose integration was interrupted still owes the
        // archive, and deleting the branch first would lose the code.
        const archived = activeWorkId !== undefined
          && (localRefs.has(`refs/heads/codepatrol/archive/${activeWorkId}`) || remoteRefs.has(`refs/heads/codepatrol/archive/${activeWorkId}`));
        if (activeWorkId !== undefined && terminal && archived) {
          terminalActiveRefs.add(ref);
          if (policy.cleanup === true) {
            const local = localRefs.get(ref);
            if (local !== undefined) localDeletions.push({ ref, hash: local });
            if (remoteRefs.has(ref)) deletions.push(ref);
          } else {
            incompleteTerminalWorks.add(activeWorkId);
          }
          continue;
        }
        if (activeWorkId !== undefined && terminal) {
          terminalActiveRefs.add(ref);
          incompleteTerminalWorks.add(activeWorkId);
          continue;
        }
        const local = localRefs.get(ref);
        const remoteHash = remoteRefs.get(ref);
        if (local === undefined && remoteHash !== undefined) incoming.push({ ref, hash: remoteHash });
        else if (local !== undefined && remoteHash === undefined) outgoing.push({ ref, hash: local });
        else if (local === remoteHash && local !== undefined) unchanged.push({ ref, commit: local, action: "unchanged" });
        else if (local !== undefined && remoteHash !== undefined) {
          if (await this.isAncestor(remoteHash, local)) outgoing.push({ ref, hash: local });
          else if (await this.isAncestor(local, remoteHash)) incoming.push({ ref, hash: remoteHash });
          else throw new CodepatrolError("SYNC_CONFLICT", `Local and remote histories diverged at ${ref}.`);
        }
      }

      for (const item of incoming) {
        const checkedOut = worktrees.find((worktree) => worktree.branchRef === item.ref);
        if (checkedOut !== undefined) {
          const status = (await executeGit(checkedOut.directory, ["status", "--porcelain", "--untracked-files=all"])).stdout.trim();
          if (status !== "") throw new CodepatrolError("GIT_DIRTY", `Cannot fast-forward dirty worktree for ${item.ref}: ${checkedOut.directory}.`);
        }
      }

      for (const item of localDeletions) {
        const checkedOut = worktrees.find((worktree) => worktree.branchRef === item.ref);
        if (checkedOut === undefined) continue;
        const status = (await executeGit(checkedOut.directory, ["status", "--porcelain", "--untracked-files=all"])).stdout.trim();
        if (status !== "") throw new CodepatrolError("GIT_DIRTY", `Cannot remove dirty terminal worktree for ${item.ref}: ${checkedOut.directory}.`);
        throw new CodepatrolError("STATE_CONFLICT", `Remove the terminal worktree before synchronization: ${checkedOut.directory}.`);
      }

      const checkedIncoming = incoming.filter((item) => worktrees.some((worktree) => worktree.branchRef === item.ref));
      for (const item of checkedIncoming) {
        const checkedOut = worktrees.find((worktree) => worktree.branchRef === item.ref);
        if (item.ref !== baseRef && checkedOut !== undefined) throw new CodepatrolError("STATE_CONFLICT", `Remove the Change worktree before pulling ${item.ref}: ${checkedOut.directory}.`);
      }
      const directIncoming = incoming.filter((item) => !checkedIncoming.includes(item));
      await updateRefsAtomically(this.workspace, [
        ...directIncoming.map((item) => ({ ref: item.ref, next: item.hash, ...(localRefs.get(item.ref) === undefined ? {} : { expected: localRefs.get(item.ref) as string }) })),
        ...localDeletions.map((item) => ({ ref: item.ref, next: "0".repeat(item.hash.length), expected: item.hash })),
      ]);
      // Git owns the checked-out base update so concurrent edits are never
      // overwritten. If this is interrupted, the next sync simply retries it.
      for (const item of checkedIncoming) {
        const checkedOut = worktrees.find((worktree) => worktree.branchRef === item.ref);
        if (checkedOut !== undefined) await executeGit(checkedOut.directory, [...WITHOUT_HOOKS, "merge", "--ff-only", item.hash]);
      }
      pulled.push(...incoming.map((item) => ({ ref: item.ref, commit: item.hash, action: "pulled" as const })));

      const pushed: GitRefSync[] = [];
      const publishableOutgoing = outgoing.filter((item) => {
        const workId = this.workIdForRef(item.ref);
        return !terminalActiveRefs.has(item.ref) && (workId === undefined || !incompleteTerminalWorks.has(workId));
      });
      if (publishableOutgoing.length > 0 || deletions.length > 0) {
        await executeGit(this.workspace, ["push", "--atomic", remote, ...publishableOutgoing.map((item) => `${item.hash}:${item.ref}`), ...deletions.map((ref) => `:${ref}`)]);
        pushed.push(...publishableOutgoing.map((item) => ({ ref: item.ref, commit: item.hash, action: "pushed" as const })));
        pushed.push(...deletions.map((ref) => ({ ref, commit: remoteRefs.get(ref) as string, action: "deleted" as const })));
      }
      return { remote, remoteConfigured, refs: [...pulled, ...pushed, ...unchanged.filter((item) => !terminalActiveRefs.has(item.ref))].sort((left, right) => left.ref.localeCompare(right.ref)) };
    });
  }
}
