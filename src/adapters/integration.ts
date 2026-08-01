import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { CodepatrolError } from "../core/errors.js";
import { GIT_HASH } from "../core/identifiers.js";
import type { WorkOutcome } from "../core/types.js";
import { archiveRef, manifestPath, serializeManifest, workBranchRef, type WorkManifest } from "../core/work-manifest.js";
import { CODEPATROL_COMMIT_ENV, executeGit, lines, WITHOUT_HOOKS } from "./git-command.js";
import { integrationReservedOffenders } from "../core/paths.js";
import { withGitRefLock } from "./git-lock.js";
import { branchCas, squashTree } from "./git-plumbing.js";
import type { Worktrees } from "./worktree.js";

export interface IntegrationResult {
  outcome: WorkOutcome;
  archiveRef: string;
  archiveCommit: string;
  baseRef: string;
  baseBefore: string;
  baseAfter: string;
  /** The squash commit, present only when the Work was accepted. */
  integrationCommit?: string;
}

function subjectOf(title: string): string {
  return title.replace(/[\r\n]+/g, " ").trim().slice(0, 72) || "work";
}

/**
 * Turns a finalized Change into its effect on the base: exactly one squash
 * commit when accepted, and none at all when rolled back.
 *
 * Integration is local. The remote is a projection, so a repository with no
 * `origin` completes the lifecycle unchanged.
 */
export class ChangeIntegration {
  constructor(readonly workspace: string, private readonly worktrees: Worktrees) {}

  private async isBaselineMerge(commit: string, baseline: string): Promise<boolean> {
    const [current, firstParent, secondParent, extra] = lines((await executeGit(this.workspace, ["rev-list", "--parents", "-n", "1", commit])).stdout)[0]?.split(" ") ?? [];
    if (current !== commit || firstParent === undefined || secondParent === undefined || extra !== undefined) return false;
    if ((await executeGit(this.workspace, ["merge-base", "--is-ancestor", secondParent, baseline], { accept: [0, 1] })).code !== 0) return false;
    const merged = await executeGit(this.workspace, ["merge-tree", "--write-tree", firstParent, secondParent], { accept: [0, 1] });
    const expectedTree = merged.stdout.split(/\r?\n/)[0]?.trim();
    const actualTree = (await executeGit(this.workspace, ["rev-parse", `${commit}^{tree}`])).stdout.trim();
    return merged.code === 0 && expectedTree === actualTree;
  }

  /**
   * A Change may write its own ledger entry — that is where the manifest lives —
   * but never another Work's, and never the runtime.
   */
  private async assertOwnLedgerOnly(manifest: WorkManifest, head: string): Promise<void> {
    const baseline = manifest.repository.baselineCommit;
    if (baseline === undefined) throw new CodepatrolError("STATE_CORRUPT", `Work ${manifest.work.id} integrates a Change with no recorded baseline.`);
    const commits = lines((await executeGit(this.workspace, ["rev-list", "--reverse", head, "--not", baseline])).stdout);
    const changed = new Set<string>();
    for (const commit of commits) {
      if (await this.isBaselineMerge(commit, baseline)) continue;
      const raw = (await executeGit(this.workspace, ["diff-tree", "-m", "--first-parent", "--root", "--no-commit-id", "--name-only", "-r", "-z", commit])).stdout;
      for (const file of raw.split("\0").filter(Boolean)) changed.add(file);
    }
    const trespass = integrationReservedOffenders([...changed], manifest.work.id);
    if (trespass.length > 0) {
      throw new CodepatrolError("RESERVED_PATH", `A Change may not modify another Work's ledger or the runtime: ${trespass.join(", ")}.`);
    }
  }

  /**
   * Pins the archive at the Change head, exactly once. The archive is the
   * frozen terminal record: it is created here and is never advanced,
   * rewritten, or deleted afterwards — a diverging archive is corruption, not
   * something to reconcile.
   */
  private async pinArchive(workId: string, head: string): Promise<string> {
    const ref = archiveRef(workId);
    const existing = (await executeGit(this.workspace, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { accept: [0, 1, 128] })).stdout.trim();
    if (existing === head) return ref;
    if (existing === "") {
      await branchCas(this.workspace, ref, head);
      return ref;
    }
    throw new CodepatrolError("STATE_CONFLICT", `Archive ref already records another commit for ${workId}: ${ref}.`);
  }

  /**
   * The tree the squash commits to the base: the Change tree with the manifest
   * replaced by the manifest ref's final state. The branch's own copy is the
   * cut-time projection — or whatever the executor's index swept along — while
   * the base must always carry a projection of the authoritative ref.
   */
  private async finalTree(manifest: WorkManifest, tree: string): Promise<string> {
    const common = path.resolve(this.workspace, (await executeGit(this.workspace, ["rev-parse", "--git-common-dir"])).stdout.trim());
    const indexFile = path.join(common, "codepatrol", `index-${randomUUID()}`);
    const env = { GIT_INDEX_FILE: indexFile };
    try {
      await mkdir(path.dirname(indexFile), { recursive: true });
      await executeGit(this.workspace, ["read-tree", tree], { env });
      const blob = (await executeGit(this.workspace, ["hash-object", "-w", "--stdin"], { env, input: serializeManifest(manifest) })).stdout.trim();
      if (!GIT_HASH.test(blob)) throw new CodepatrolError("GIT_ERROR", "git hash-object returned an invalid object id.");
      await executeGit(this.workspace, ["update-index", "--add", "--cacheinfo", `100644,${blob},${manifestPath(manifest.work.id)}`], { env });
      const final = (await executeGit(this.workspace, ["write-tree"], { env })).stdout.trim();
      if (!GIT_HASH.test(final)) throw new CodepatrolError("GIT_ERROR", "git write-tree returned an invalid tree.");
      return final;
    } finally {
      await rm(indexFile, { force: true }).catch(() => undefined);
    }
  }

  async integrate(input: { manifest: WorkManifest; head: string; issue?: number }): Promise<IntegrationResult> {
    return withGitRefLock(this.workspace, "repository", () => this.integrateLocked(input));
  }

  private async integrateLocked(input: { manifest: WorkManifest; head: string; issue?: number }): Promise<IntegrationResult> {
    const { manifest, head } = input;
    const outcome = manifest.completion?.outcome;
    if (outcome === undefined) throw new CodepatrolError("STATE_CORRUPT", `Work ${manifest.work.id} has no terminal decision to integrate.`);
    if (!GIT_HASH.test(head)) throw new CodepatrolError("STATE_CORRUPT", "The finalized manifest commit is invalid.");

    const baseRef = manifest.repository.baseRef;
    const baseBefore = (await executeGit(this.workspace, ["rev-parse", baseRef])).stdout.trim();
    if (outcome === "accepted") {
      const integrated = lines((await executeGit(this.workspace, ["log", baseRef, "--format=%H", "--fixed-strings", `--grep=Codepatrol-Work: ${manifest.work.id}`])).stdout);
      if (integrated.length > 1) throw new CodepatrolError("STATE_CORRUPT", `Multiple integration commits exist for ${manifest.work.id}.`);
      const existing = integrated[0];
      if (existing !== undefined) {
        const parent = (await executeGit(this.workspace, ["rev-parse", `${existing}^`])).stdout.trim();
        const existingTree = (await executeGit(this.workspace, ["rev-parse", `${existing}^{tree}`])).stdout.trim();
        const expected = await squashTree(this.workspace, parent, head);
        const expectedTree = expected.conflicted ? "" : await this.finalTree(manifest, expected.tree);
        if (expected.conflicted || expectedTree !== existingTree) throw new CodepatrolError("STATE_CORRUPT", `Integration trailer for ${manifest.work.id} does not match its Change tree.`);
        const archive = await this.pinArchive(manifest.work.id, head);
        await this.worktrees.remove(manifest.work.id);
        await this.deleteBranch(manifest.work.id, head);
        return { outcome, archiveRef: archive, archiveCommit: head, baseRef, baseBefore, baseAfter: baseBefore, integrationCommit: existing };
      }
    }
    // Refuse before computing anything we would have to undo.
    const baseCheckout = outcome === "accepted" ? await this.worktrees.baseCheckout(baseRef) : undefined;
    await this.assertOwnLedgerOnly(manifest, head);
    const archive = await this.pinArchive(manifest.work.id, head);

    if (outcome === "rolled-back") {
      // A rolled-back Work leaves the base untouched and survives only here.
      await this.worktrees.remove(manifest.work.id);
      await this.deleteBranch(manifest.work.id, head);
      return { outcome, archiveRef: archive, archiveCommit: head, baseRef, baseBefore, baseAfter: baseBefore };
    }

    const squash = await squashTree(this.workspace, baseRef, head);
    if (squash.conflicted) {
      throw new CodepatrolError("STATE_CONFLICT", `The Change conflicts with ${baseRef} at: ${squash.paths.join(", ")}. Update the Change branch and verify again.`);
    }
    const trailers = [
      `Codepatrol-Work: ${manifest.work.id}`,
      ...(input.issue === undefined ? [] : [`Codepatrol-Issue: #${input.issue}`]),
    ];
    const commit = (await executeGit(this.workspace, [
      ...WITHOUT_HOOKS,
      "commit-tree", await this.finalTree(manifest, squash.tree),
      "-p", baseBefore,
      "-m", `${manifest.work.id}: ${subjectOf(manifest.work.title)}`,
      "-m", trailers.join("\n"),
    ], { env: CODEPATROL_COMMIT_ENV })).stdout.trim();
    if (!GIT_HASH.test(commit)) throw new CodepatrolError("GIT_ERROR", "git commit-tree returned an invalid object id.");

    if (baseCheckout === undefined) await branchCas(this.workspace, baseRef, commit, baseBefore);
    else await this.worktrees.advanceBase(baseRef, commit, baseCheckout);
    await this.worktrees.remove(manifest.work.id);
    await this.deleteBranch(manifest.work.id, head);
    return { outcome, archiveRef: archive, archiveCommit: head, baseRef, baseBefore, baseAfter: commit, integrationCommit: commit };
  }

  private async deleteBranch(workId: string, expected: string): Promise<void> {
    const ref = workBranchRef(workId);
    const current = (await executeGit(this.workspace, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { accept: [0, 1, 128] })).stdout.trim();
    if (current === "") return;
    if (current !== expected) {
      // Commits landed after the Change was finalized; keep them rather than
      // deleting them with the branch.
      const recovery = `refs/heads/codepatrol/recovery/${workId}/${current.slice(0, 12)}`;
      await executeGit(this.workspace, [...WITHOUT_HOOKS, "update-ref", recovery, current], { accept: [0, 1, 128] });
    }
    await executeGit(this.workspace, [...WITHOUT_HOOKS, "update-ref", "-d", ref, current], { accept: [0, 1, 128] });
  }
}
