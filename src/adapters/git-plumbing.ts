import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { CodepatrolError } from "../core/errors.js";
import { GIT_HASH } from "../core/identifiers.js";
import { CODEPATROL_COMMIT_ENV, executeGit, lines, WITHOUT_HOOKS } from "./git-command.js";

export interface BlobWrite {
  /** Repository-relative path. */
  path: string;
  contents: string;
  mode?: "100644" | "100755";
}

async function commonDirectory(workspace: string): Promise<string> {
  const raw = (await executeGit(workspace, ["rev-parse", "--git-common-dir"])).stdout.trim();
  return path.resolve(workspace, raw);
}

async function writeBlob(workspace: string, contents: string): Promise<string> {
  const written = await executeGit(workspace, ["hash-object", "-w", "--stdin"], { input: contents });
  const blob = written.stdout.trim();
  if (!GIT_HASH.test(blob)) throw new CodepatrolError("GIT_ERROR", "git hash-object returned an invalid object id.");
  return blob;
}

/**
 * Compare-and-swap on a branch ref. `expected` is the value the ref must
 * currently hold; omit it to require that the ref does not exist yet.
 */
export async function branchCas(workspace: string, ref: string, next: string, expected?: string): Promise<void> {
  const result = await executeGit(workspace, [...WITHOUT_HOOKS, "update-ref", ref, next, expected ?? "0".repeat(next.length)], { accept: [0, 1, 128] });
  if (result.code !== 0) {
    throw new CodepatrolError("STATE_CONFLICT", `${ref} moved while it was being updated; expected ${expected ?? "no ref"}.`);
  }
}

export interface RefUpdate {
  ref: string;
  /** The value to move to, or null to delete the ref. */
  next: string | null;
  expected?: string;
}

/**
 * Moves every ref or none.
 *
 * `git update-ref --stdin` is transactional by default, which is what lets one
 * a document creates several Works — each with its own branch and pointer — without
 * a window where half the graph exists.
 */
export async function updateRefsAtomically(workspace: string, updates: readonly RefUpdate[]): Promise<void> {
  if (updates.length === 0) return;
  const zero = "0".repeat(40);
  const input = [
    "start",
    ...updates.map((update) => update.next === null
      ? `delete ${update.ref} ${update.expected ?? ""}`.trimEnd()
      : `update ${update.ref} ${update.next} ${update.expected ?? zero}`),
    "prepare",
    "commit",
    "",
  ].join("\n");
  const result = await executeGit(workspace, [...WITHOUT_HOOKS, "update-ref", "--stdin"], { input, accept: [0, 1, 128] });
  if (result.code !== 0) {
    const detail = result.stderr.trim();
    throw new CodepatrolError("STATE_CONFLICT", `Git refs moved while an atomic checkpoint was being written${detail === "" ? "" : `: ${detail}`}.`);
  }
}

/**
 * Every path touched by the commits reachable from `to` but not from `from`.
 *
 * Walking commit by commit rather than diffing the endpoints matters: a path
 * added and then removed inside the range is invisible to an endpoint diff but
 * is still a modification the range performed.
 */
export async function changedPaths(workspace: string, from: string, to: string): Promise<string[]> {
  if (from === to) return [];
  const commits = lines((await executeGit(workspace, ["rev-list", "--reverse", to, "--not", from])).stdout);
  const paths = new Set<string>();
  for (const commit of commits) {
    const raw = (await executeGit(workspace, ["diff-tree", "-m", "--first-parent", "--root", "--no-commit-id", "--name-only", "-r", "-z", commit])).stdout;
    for (const file of raw.split("\0").filter(Boolean)) paths.add(file);
  }
  return [...paths].sort();
}

export interface CommitOnBranchInput {
  workspace: string;
  branchRef: string;
  /** Commit the new one is parented to. */
  parent: string;
  /** Current value of `branchRef`; omit when the branch is being created. */
  expected?: string;
  writes: readonly BlobWrite[];
  subject: string;
  trailers?: readonly string[];
  /** Additional refs advanced to the new commit in the same transaction. */
  linkedRefs?: readonly { ref: string; expected?: string }[];
}

export interface CommitOnBranchResult {
  commit: string;
  /** False when the writes produced no tree change, so no commit was made. */
  changed: boolean;
}

export interface PreparedCommit extends CommitOnBranchResult {
  /** The ref moves this commit needs; empty when nothing changed. */
  updates: RefUpdate[];
}

/**
 * Commits `writes` onto `branchRef` without any checkout, using a throwaway
 * index. This is the only write path for Codepatrol's own files.
 *
 * Using plumbing rather than `git commit` in a worktree matters for three
 * reasons: it is not refused mid-merge or mid-rebase, it never runs hooks or
 * needs a second committer-identity resolution, and it ignores `.gitignore`
 * entirely, so no `git add -f` workaround is required.
 */
export async function commitOnBranch(input: CommitOnBranchInput): Promise<CommitOnBranchResult> {
  const prepared = await prepareCommitOnBranch(input);
  await updateRefsAtomically(input.workspace, prepared.updates);
  return { commit: prepared.commit, changed: prepared.changed };
}

/**
 * Builds the commit and works out which refs must move, without moving them.
 *
 * Git objects that nothing points at are inert, so a caller may prepare several
 * commits and then land them all in one transaction — or abandon them, leaving
 * only garbage for the next `git gc`.
 */
export async function prepareCommitOnBranch(input: CommitOnBranchInput): Promise<PreparedCommit> {
  if (input.writes.length === 0) throw new CodepatrolError("INVALID_INPUT", "A commit needs at least one write.");
  const indexRoot = path.join(await commonDirectory(input.workspace), "codepatrol");
  await mkdir(indexRoot, { recursive: true });
  const indexFile = path.join(indexRoot, `index-${randomUUID()}`);
  const env = { GIT_INDEX_FILE: indexFile };
  try {
    await executeGit(input.workspace, ["read-tree", input.parent], { env });
    for (const write of input.writes) {
      const blob = await writeBlob(input.workspace, write.contents);
      await executeGit(input.workspace, ["update-index", "--add", "--cacheinfo", `${write.mode ?? "100644"},${blob},${write.path}`], { env });
    }
    const tree = (await executeGit(input.workspace, ["write-tree"], { env })).stdout.trim();
    const parentTree = (await executeGit(input.workspace, ["rev-parse", `${input.parent}^{tree}`])).stdout.trim();
    if (tree === parentTree) {
      const refs = [
        { ref: input.branchRef, expected: input.expected ?? undefined },
        ...(input.linkedRefs ?? []),
      ];
      for (const ref of refs) {
        const actual = (await executeGit(input.workspace, ["rev-parse", "--verify", "--quiet", ref.ref], { accept: [0, 1, 128] })).stdout.trim();
        const expected = ref.expected ?? "";
        if (actual !== expected) throw new CodepatrolError("STATE_CONFLICT", `${ref.ref} moved while a no-op checkpoint was being verified.`);
      }
      return { commit: input.parent, changed: false, updates: [] };
    }

    const message = [
      "-m", input.subject,
      ...(input.trailers === undefined || input.trailers.length === 0 ? [] : ["-m", input.trailers.join("\n")]),
    ];
    const commit = (await executeGit(input.workspace, [...WITHOUT_HOOKS, "commit-tree", tree, "-p", input.parent, ...message], { env: CODEPATROL_COMMIT_ENV })).stdout.trim();
    if (!GIT_HASH.test(commit)) throw new CodepatrolError("GIT_ERROR", "git commit-tree returned an invalid object id.");
    const updates: RefUpdate[] = [
      { ref: input.branchRef, next: commit, ...(input.expected === undefined ? {} : { expected: input.expected }) },
      ...(input.linkedRefs ?? []).map((ref) => ({ ref: ref.ref, next: commit, ...(ref.expected === undefined ? {} : { expected: ref.expected }) })),
    ];
    return { commit, changed: true, updates };
  } finally {
    await rm(indexFile, { force: true }).catch(() => undefined);
  }
}

/**
 * Realigns a live worktree's index with paths Codepatrol just committed on the
 * branch behind its back.
 *
 * `update-index --cacheinfo` writes a zeroed stat entry, so the next
 * `git status` re-hashes exactly these paths, finds them equal, and reports
 * clean. No other index entry is touched, so a builder's staged and unstaged
 * work survives byte for byte.
 */
export async function reconcileWorktreeIndex(workspace: string, worktree: string, writes: readonly BlobWrite[]): Promise<void> {
  for (const write of writes) {
    const absolute = path.join(worktree, write.path);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, write.contents, "utf8");
    const blob = await writeBlob(workspace, write.contents);
    await executeGit(worktree, ["update-index", "--add", "--cacheinfo", `${write.mode ?? "100644"},${blob},${write.path}`]);
  }
}

export type SquashOutcome =
  | { conflicted: false; tree: string }
  | { conflicted: true; paths: string[] };

/**
 * Computes the tree that squashing `head` onto `base` would produce, without
 * touching any working tree or index.
 *
 * This is what lets ship run from any checkout, dirty or not, and report a
 * conflict with its paths while nothing has been mutated.
 */
export async function squashTree(workspace: string, base: string, head: string): Promise<SquashOutcome> {
  const mergeBase = (await executeGit(workspace, ["merge-base", base, head])).stdout.trim();
  const result = await executeGit(workspace, ["merge-tree", "--write-tree", "--merge-base", mergeBase, base, head], { accept: [0, 1] });
  const [tree, ...rest] = result.stdout.split(/\r?\n/);
  if (tree === undefined || !GIT_HASH.test(tree.trim())) throw new CodepatrolError("GIT_ERROR", "git merge-tree returned an invalid tree.");
  if (result.code === 0) return { conflicted: false, tree: tree.trim() };
  const paths = new Set<string>();
  for (const line of rest) {
    const match = /^\d{6} [0-9a-f]+ [123]\t(.+)$/.exec(line);
    if (match?.[1] !== undefined) paths.add(match[1]);
  }
  return { conflicted: true, paths: [...paths].sort() };
}
