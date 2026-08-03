import { CodepatrolError } from "../core/errors.js";
import { GIT_HASH, WORK_CODE, WORK_ID } from "../core/identifiers.js";
import { INITIATIVE_ID, initiativePath, initiativeRef, parseInitiative, serializeInitiative, type Initiative } from "../core/initiative.js";
import {
  archiveRef,
  createManifest,
  manifestPath,
  manifestRef,
  parseWorkManifest,
  serializeManifest,
  workBranchRef,
  type WorkManifest,
} from "../core/work-manifest.js";
import { STAGES, type WorkIdentity } from "../core/types.js";
import { graphDigest } from "../core/work-graph.js";
import { CODEPATROL_COMMIT_ENV, excludeRuntime, executeGit, lines, resolveBaseRef, WITHOUT_HOOKS } from "./git-command.js";
import { withGitRefLock } from "./git-lock.js";
import { changedPaths, commitOnBranch, prepareCommitOnBranch, updateRefsAtomically, type RefUpdate } from "./git-plumbing.js";
import { integrationReservedOffenders } from "../core/paths.js";

/** Where a manifest was resolved from. The manifest ref is the authority. */
export type ManifestSource = "manifest" | "archive" | "base";

export interface ManifestRevision {
  manifest: WorkManifest;
  /** The manifest commit: the manifest ref's value, and the expected value of the next write. */
  commit: string;
  source: ManifestSource;
  /** The code head (work branch, else archive) when the Work has one. */
  codeHead?: string;
}

const MAX_WRITE_ATTEMPTS = 3;

/**
 * Side effects a manifest write must trigger outside the store, supplied at
 * construction rather than registered afterwards so a store is never observable
 * in a half-wired state.
 */
export interface ManifestStoreHooks {
  /** A manifest checkpoint landed; reconcile any live checkout. */
  onCheckpoint?(workId: string, previous: string, next: string): Promise<void>;
  /** Runs before a refresh mutates anything, and may refuse it. */
  onRefreshPreflight?(workId: string, manifest: WorkManifest): Promise<void>;
  /** The Change branch moved to `commit`; realign any live checkout. */
  onRefreshed?(workId: string, commit: string): Promise<void>;
}

export interface ManifestStoreOptions extends ManifestStoreHooks {
  /** Explicit base branch; resolved from the repository when omitted. */
  base?: string;
}

export class GitManifestStore {
  private resolvedBase: string | undefined;
  private readonly configuredBase: string | undefined;

  constructor(readonly workspace: string, private readonly options: ManifestStoreOptions = {}) {
    this.configuredBase = options.base;
  }

  async baseRef(): Promise<string> {
    this.resolvedBase ??= await resolveBaseRef(this.workspace, this.configuredBase);
    return this.resolvedBase;
  }

  private async refCommit(ref: string): Promise<string | undefined> {
    const result = await executeGit(this.workspace, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { accept: [0, 1, 128] });
    const commit = result.stdout.trim();
    return result.code === 0 && GIT_HASH.test(commit) ? commit : undefined;
  }

  private async manifestAt(ref: string, workId: string): Promise<WorkManifest | undefined> {
    const stored = await executeGit(this.workspace, ["show", `${ref}:${manifestPath(workId)}`], { accept: [0, 128] });
    if (stored.code !== 0) return undefined;
    try {
      return parseWorkManifest(JSON.parse(stored.stdout) as unknown, workId);
    } catch (error) {
      if (error instanceof SyntaxError) throw new CodepatrolError("STATE_CORRUPT", `Work manifest contains invalid JSON: ${workId}.`);
      throw error;
    }
  }

  /**
   * Executor commits may not write repository state. The manifest is safe on
   * its own ref — the branch carries only a frozen projection of it, which the
   * executor's commits inevitably touch when the realigned index is committed,
   * and which integration replaces with the ref's final state anyway. Another
   * Work's ledger, or the runtime, is refused as soon as it is observable.
   */
  private async assertExecutorRange(workId: string, from: string, to: string): Promise<void> {
    const offenders = integrationReservedOffenders(await changedPaths(this.workspace, from, to), workId);
    if (offenders.length > 0) throw new CodepatrolError("RESERVED_PATH", `Executor commits may not modify .codepatrol/: ${offenders.join(", ")}.`);
  }

  /**
   * Resolves a Work from its manifest ref — its home — falling back to the
   * archive and the base only where the ref has not been fetched yet. Branches
   * are code, never the record: deleting one leaves the Work exactly as it was.
   */
  async read(workId: string): Promise<ManifestRevision> {
    if (!WORK_ID.test(workId)) throw new CodepatrolError("INVALID_WORK_ID", `Invalid work id: ${workId}.`);
    const ref = manifestRef(workId);
    const refCommit = await this.refCommit(ref);
    if (refCommit !== undefined) {
      const manifest = await this.manifestAt(ref, workId);
      if (manifest === undefined) throw new CodepatrolError("STATE_CORRUPT", `Manifest ref for ${workId} does not contain its manifest.`);
      const branchHead = await this.refCommit(workBranchRef(workId));
      if (branchHead !== undefined && manifest.repository.baselineCommit !== undefined) {
        await this.assertExecutorRange(workId, manifest.repository.baselineCommit, branchHead);
      }
      const codeHead = branchHead ?? await this.refCommit(archiveRef(workId));
      return { manifest, commit: refCommit, source: "manifest", ...(codeHead === undefined ? {} : { codeHead }) };
    }

    const archive = archiveRef(workId);
    const archiveHead = await this.refCommit(archive);
    if (archiveHead !== undefined) {
      const archived = await this.manifestAt(archive, workId);
      if (archived !== undefined) return { manifest: archived, commit: archiveHead, source: "archive", codeHead: archiveHead };
    }
    const base = await this.baseRef();
    const inBase = await this.manifestAt(base, workId);
    if (inBase !== undefined) {
      const added = (await executeGit(this.workspace, ["log", base, "-1", "--diff-filter=A", "--format=%H", "--", manifestPath(workId)])).stdout.trim();
      if (!GIT_HASH.test(added)) throw new CodepatrolError("STATE_CORRUPT", `Could not locate the integration commit for ${workId}.`);
      return { manifest: inBase, commit: added, source: "base" };
    }
    throw new CodepatrolError("WORK_NOT_FOUND", `Work manifest not found: ${workId}.`);
  }

  async list(): Promise<ManifestRevision[]> {
    const ids = new Set<string>();
    for (const ref of lines((await executeGit(this.workspace, ["for-each-ref", "--format=%(refname)", "refs/codepatrol/manifest/", "refs/heads/codepatrol/archive/"])).stdout)) {
      const id = /^refs\/(?:codepatrol\/manifest|heads\/codepatrol\/archive)\/(.+)$/.exec(ref)?.[1];
      if (id !== undefined && WORK_ID.test(id)) ids.add(id);
    }
    const base = await this.baseRef();
    for (const name of lines((await executeGit(this.workspace, ["ls-tree", "-r", "--name-only", base, "--", ".codepatrol/works"], { accept: [0, 128] })).stdout)) {
      const id = /^\.codepatrol\/works\/(.+)\/work\.json$/.exec(name)?.[1];
      if (id !== undefined && WORK_ID.test(id)) ids.add(id);
    }
    const revisions = await Promise.all([...ids].sort().map((id) => this.read(id)));
    // Newest first, with the id breaking ties so the listing is deterministic.
    return revisions.sort((left, right) =>
      right.manifest.work.createdAt.localeCompare(left.manifest.work.createdAt)
      || left.manifest.work.id.localeCompare(right.manifest.work.id),
    );
  }

  /**
   * Resolves a caller-supplied identifier to the canonical slugged Work id.
   * A full WORK_ID returns as-is. A short WORK_CODE (INIT-<n>.<p>) is matched
   * against the same enumeration list() uses; exactly one Work carries the
   * number pair by construction, so a single match is the only possible
   * outcome. Anything else, or no match, raises INVALID_WORK_ID — the same
   * code the validation surfaces today — so callers do not branch on form.
   *
   * Existence of the resolved id stays read's job: this method's contract is
   * to translate a human-typed handle into the stored form, not to confirm
   * the Work still exists.
   */
  async resolve(idOrCode: string): Promise<string> {
    if (WORK_ID.test(idOrCode)) return idOrCode;
    if (!WORK_CODE.test(idOrCode)) throw new CodepatrolError("INVALID_WORK_ID", `Invalid work id: ${idOrCode}.`);
    const prefix = `${idOrCode}-`;
    const found = new Set<string>();
    for (const ref of lines((await executeGit(this.workspace, ["for-each-ref", "--format=%(refname)", "refs/codepatrol/manifest/", "refs/heads/codepatrol/archive/"])).stdout)) {
      const id = /^refs\/(?:codepatrol\/manifest|heads\/codepatrol\/archive)\/(.+)$/.exec(ref)?.[1];
      if (id !== undefined && id.startsWith(prefix) && WORK_ID.test(id)) found.add(id);
    }
    const base = await this.baseRef();
    for (const name of lines((await executeGit(this.workspace, ["ls-tree", "-r", "--name-only", base, "--", ".codepatrol/works"], { accept: [0, 128] })).stdout)) {
      const id = /^\.codepatrol\/works\/(.+)\/work\.json$/.exec(name)?.[1];
      if (id !== undefined && id.startsWith(prefix) && WORK_ID.test(id)) found.add(id);
    }
    if (found.size === 0) throw new CodepatrolError("INVALID_WORK_ID", `Invalid work id: ${idOrCode}.`);
    if (found.size > 1) throw new CodepatrolError("STATE_CORRUPT", `Short code ${idOrCode} matched multiple Works: ${[...found].sort().join(", ")}.`);
    return [...found][0]!;
  }

  /**
   * Writes `next` on top of `expected`, refusing if the manifest ref moved in
   * between. The manifest ref is the only writable home of the record; code
   * branches are never touched by a manifest write.
   */
  async write(expected: ManifestRevision, next: WorkManifest, subject: string): Promise<ManifestRevision> {
    const workId = next.work.id;
    if (expected.source !== "manifest") throw new CodepatrolError("STATE_CONFLICT", `Work ${workId} has no writable manifest ref.`);
    const previous = serializeManifest(expected.manifest);
    const contents = serializeManifest(next);
    parseWorkManifest(JSON.parse(contents) as unknown, workId);
    const committed = await commitOnBranch({
      workspace: this.workspace,
      branchRef: manifestRef(workId),
      parent: expected.commit,
      expected: expected.commit,
      writes: [{ path: manifestPath(workId), contents }],
      subject,
      trailers: [`Codepatrol-Work: ${workId}`],
    });
    if (committed.changed) await this.options.onCheckpoint?.(workId, previous, contents);
    return { manifest: next, commit: committed.commit, source: "manifest", ...(expected.codeHead === undefined ? {} : { codeHead: expected.codeHead }) };
  }

  /**
   * Read, apply, write — retrying when the branch moved underneath. The
   * concurrent writer is almost always a builder committing code, which does
   * not touch the lifecycle record, so replaying the change onto the fresh
   * manifest is safe.
   */
  async update(workId: string, mutate: (revision: ManifestRevision) => WorkManifest | Promise<WorkManifest>, subject: string): Promise<ManifestRevision> {
    return withGitRefLock(this.workspace, `work/${workId}`, async () => {
      let lastError: unknown;
      for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt += 1) {
        const current = await this.read(workId);
        try {
          return await this.write(current, await mutate(current), subject);
        } catch (error) {
          if (!(error instanceof CodepatrolError) || error.code !== "STATE_CONFLICT") throw error;
          lastError = error;
        }
      }
      throw lastError instanceof Error
        ? lastError
        : new CodepatrolError("STATE_CONFLICT", `Could not write the manifest for ${workId} after ${MAX_WRITE_ATTEMPTS} attempts.`);
    });
  }

  async refresh(workId: string, at: string): Promise<ManifestRevision> {
    return withGitRefLock(this.workspace, `work/${workId}`, () => withGitRefLock(this.workspace, "repository", async () => {
      const current = await this.read(workId);
      const manifest = current.manifest;
      if (current.source !== "manifest" || manifest.workflow.state === "terminal") throw new CodepatrolError("INVALID_TRANSITION", `Work ${workId} cannot be refreshed.`);
      if (manifest.workflow.state === "active") throw new CodepatrolError("INVALID_TRANSITION", `Complete the active ${manifest.workflow.stage} run before refreshing.`);
      const branchRef = workBranchRef(workId);
      const branchHead = await this.refCommit(branchRef);
      const baseline = manifest.repository.baselineCommit;
      // A branchless Work has no baseline to drift from: the cut records it.
      if (branchHead === undefined || baseline === undefined) return current;
      await this.options.onRefreshPreflight?.(workId, manifest);
      const target = (await executeGit(this.workspace, ["rev-parse", manifest.repository.baseRef])).stdout.trim();
      if (!GIT_HASH.test(target)) throw new CodepatrolError("GIT_BRANCH", `The base branch does not exist: ${manifest.repository.baseRef}.`);
      if (target === baseline) return current;

      const merged = await executeGit(this.workspace, ["merge-tree", "--write-tree", "--merge-base", baseline, target, branchHead], { accept: [0, 1] });
      const [tree, ...details] = merged.stdout.split(/\r?\n/);
      if (tree === undefined || !GIT_HASH.test(tree.trim())) throw new CodepatrolError("GIT_ERROR", "git merge-tree returned an invalid tree.");
      if (merged.code !== 0) {
        const paths = new Set<string>();
        for (const line of details) {
          const match = /^\d{6} [0-9a-f]+ [123]\t(.+)$/.exec(line);
          if (match?.[1] !== undefined) paths.add(match[1]);
        }
        throw new CodepatrolError("STATE_CONFLICT", `The Change conflicts with ${manifest.repository.baseRef} at: ${[...paths].sort().join(", ")}.`);
      }
      const mergeCommit = (await executeGit(this.workspace, [
        ...WITHOUT_HOOKS,
        "commit-tree", tree.trim(),
        "-p", branchHead,
        "-p", target,
        "-m", `refresh(${workId}): ${manifest.repository.baseRef}`,
      ], { env: CODEPATROL_COMMIT_ENV })).stdout.trim();
      if (!GIT_HASH.test(mergeCommit)) throw new CodepatrolError("GIT_ERROR", "git commit-tree returned an invalid refresh commit.");

      const verifyIndex = manifest.attempts.findIndex((attempt) => attempt.stage === "verify" && attempt.status === "completed");
      const attempts = verifyIndex < 0 ? manifest.attempts : manifest.attempts.map((attempt) =>
        attempt.status === "completed" && STAGES.indexOf(attempt.stage) >= STAGES.indexOf("verify") ? { ...attempt, status: "invalidated" as const } : attempt,
      );
      const next: WorkManifest = {
        ...manifest,
        repository: { ...manifest.repository, baselineCommit: target },
        ...(verifyIndex < 0 ? {} : { workflow: { state: "ready" as const, stage: "verify" as const, attempt: attempts.filter((attempt) => attempt.stage === "verify").length + 1, updatedAt: at } }),
        attempts,
      };
      const previous = serializeManifest(manifest);
      const contents = serializeManifest(next);
      parseWorkManifest(JSON.parse(contents) as unknown, workId);
      const prepared = await prepareCommitOnBranch({
        workspace: this.workspace,
        branchRef: manifestRef(workId),
        parent: current.commit,
        expected: current.commit,
        writes: [{ path: manifestPath(workId), contents }],
        subject: `refresh(${workId}): baseline`,
        trailers: [`Codepatrol-Work: ${workId}`],
      });
      await updateRefsAtomically(this.workspace, [
        { ref: branchRef, next: mergeCommit, expected: branchHead },
        ...prepared.updates,
      ]);
      if (prepared.changed) await this.options.onCheckpoint?.(workId, previous, contents);
      await this.options.onRefreshed?.(workId, mergeCommit);
      return { manifest: next, commit: prepared.commit, source: "manifest", codeHead: mergeCommit };
    }));
  }

  /**
   * Applies a whole batch of manifests in one ref transaction.
   *
   * Creating three Works and rewiring two dependencies has to be all or
   * nothing: a partially applied batch would leave a graph nobody proposed
   * and nobody could reason about. Every commit is built first — unreferenced
   * objects are inert — and only then does a single `update-ref --stdin` move
   * every manifest ref, branch, archive, and Initiative together.
   */
  async applyBatch(input: {
    /** Graph snapshot checked again while the transaction is locked. */
    expectedGraphDigest?: string;
    /** When present, created inside the same transaction, CAS against absence. */
    initiative?: Initiative;
    creates: readonly { identity: WorkIdentity; blockedBy: readonly string[] }[];
    /** `mutate` runs against the manifest as freshly read under the lock. */
    writes: readonly { workId: string; subject: string; mutate(current: WorkManifest): WorkManifest }[];
    /** Works whose Change is finished and moves to its archive. */
    archives: readonly string[];
    subject: string;
  }): Promise<{ revisions: ManifestRevision[]; initiative?: Initiative }> {
    return withGitRefLock(this.workspace, "repository", async () => {
      await excludeRuntime(this.workspace);
      const base = await this.baseRef();
      const baseCommit = await this.refCommit(base);
      if (baseCommit === undefined) throw new CodepatrolError("GIT_BRANCH", `The base branch does not exist: ${base}.`);

      const updates: RefUpdate[] = [];
      const results: ManifestRevision[] = [];
      const reconcile: Array<{ workId: string; previous: string; next: string }> = [];
      const snapshot = input.expectedGraphDigest === undefined ? [] : await this.list();
      if (input.expectedGraphDigest !== undefined) {
        const observed = graphDigest(snapshot.map((revision) => revision.manifest));
        if (observed !== input.expectedGraphDigest) {
          throw new CodepatrolError("DOCUMENT_REJECTED", "[STALE_DOCUMENT] The Work graph moved before the document transaction acquired its snapshot.", 1, {
            expected: `graph ${input.expectedGraphDigest}`,
            observed: `graph ${observed}`,
            committed: ["nothing was applied; the Work graph is unchanged"],
            nextCommand: "codepatrol spec inspect",
          });
        }
      }

      // The Initiative is minted by the caller (who needs its id to mint Work
      // ids) and created here, under the repository lock, with a
      // compare-and-swap against absence: two concurrent applies cannot mint
      // the same number, and a failed apply mints none because the whole
      // transaction is atomic.
      const initiative = input.initiative;
      if (initiative !== undefined) {
        const prepared = await prepareCommitOnBranch({
          workspace: this.workspace,
          branchRef: initiativeRef(initiative.id, initiative.slug),
          parent: baseCommit,
          writes: [{ path: initiativePath(), contents: serializeInitiative(initiative) }],
          subject: `spec(${initiative.id}): ${subjectOf(initiative.title)}`,
        });
        updates.push(...prepared.updates);
      }

      for (const create of input.creates) {
        const ref = manifestRef(create.identity.id);
        if (await this.refCommit(ref) !== undefined) throw new CodepatrolError("STATE_CONFLICT", `Work already exists: ${create.identity.id}.`);
        const manifest = createManifest({ identity: create.identity, baseRef: base, blockedBy: create.blockedBy });
        const contents = serializeManifest(manifest);
        parseWorkManifest(JSON.parse(contents) as unknown, create.identity.id);
        const prepared = await prepareCommitOnBranch({
          workspace: this.workspace,
          branchRef: ref,
          parent: baseCommit,
          writes: [{ path: manifestPath(create.identity.id), contents }],
          subject: `spec(${create.identity.id}): ${subjectOf(create.identity.title)}`,
          trailers: [`Codepatrol-Work: ${create.identity.id}`],
        });
        updates.push(...prepared.updates);
        results.push({ manifest, commit: prepared.commit, source: "manifest" });
      }

      const archived = new Set(input.archives);
      for (const write of input.writes) {
        const workId = write.workId;
        const current = await this.read(workId);
        if (current.source !== "manifest") throw new CodepatrolError("STATE_CONFLICT", `Work ${workId} has no writable manifest ref.`);
        const previous = serializeManifest(current.manifest);
        const next = write.mutate(current.manifest);
        const contents = serializeManifest(next);
        parseWorkManifest(JSON.parse(contents) as unknown, workId);
        const prepared = await prepareCommitOnBranch({
          workspace: this.workspace,
          branchRef: manifestRef(workId),
          parent: current.commit,
          expected: current.commit,
          writes: [{ path: manifestPath(workId), contents }],
          subject: write.subject,
          trailers: [`Codepatrol-Work: ${workId}`],
        });
        if (!prepared.changed) {
          results.push(current);
          continue;
        }
        updates.push(...prepared.updates);
        let codeHead = current.codeHead;
        if (archived.has(workId)) {
          // The Work is terminal: its code — when it has any — moves to the
          // archive and the working branch goes away in the same transaction.
          // A Work that never had content terminalizes on its manifest ref alone.
          const branchHead = await this.refCommit(workBranchRef(workId));
          if (branchHead !== undefined) {
            const archive = archiveRef(workId);
            const existing = await this.refCommit(archive);
            if (existing === undefined) updates.push({ ref: archive, next: branchHead });
            else if (existing !== branchHead) throw new CodepatrolError("STATE_CONFLICT", `Archive for ${workId} diverges from its Change branch.`);
            updates.push({ ref: workBranchRef(workId), next: null, expected: branchHead });
            codeHead = branchHead;
          }
        } else {
          reconcile.push({ workId, previous, next: contents });
        }
        results.push({ manifest: next, commit: prepared.commit, source: "manifest", ...(codeHead === undefined ? {} : { codeHead }) });
      }

      const written = new Set(input.writes.map((write) => write.workId));
      for (const revision of snapshot) {
        const workId = revision.manifest.work.id;
        if (written.has(workId)) continue;
        const ref = manifestRef(workId);
        const commit = await this.refCommit(ref);
        if (commit === undefined) continue;
        updates.push({ ref, next: commit, expected: commit });
      }

      await updateRefsAtomically(this.workspace, updates);
      for (const item of reconcile) await this.options.onCheckpoint?.(item.workId, item.previous, item.next);
      return { revisions: results, ...(initiative === undefined ? {} : { initiative }) };
    });
  }

  /** Every Initiative, read from its own ref; membership is never stored here. */
  async listInitiatives(): Promise<Initiative[]> {
    const found: Initiative[] = [];
    for (const ref of lines((await executeGit(this.workspace, ["for-each-ref", "--format=%(refname)", "refs/codepatrol/initiative/"])).stdout)) {
      const stored = await executeGit(this.workspace, ["show", `${ref}:${initiativePath()}`], { accept: [0, 128] });
      if (stored.code !== 0) throw new CodepatrolError("STATE_CORRUPT", `Initiative ref has no document: ${ref}.`);
      try {
        found.push(parseInitiative(JSON.parse(stored.stdout) as unknown));
      } catch (error) {
        if (error instanceof SyntaxError) throw new CodepatrolError("STATE_CORRUPT", `Initiative document contains invalid JSON: ${ref}.`);
        throw error;
      }
    }
    return found.sort((left, right) => left.id.localeCompare(right.id) || left.createdAt.localeCompare(right.createdAt));
  }

  /** Reads one Initiative by id (`INIT-<n>`). */
  async readInitiative(id: string): Promise<Initiative> {
    if (!INITIATIVE_ID.test(id)) throw new CodepatrolError("INVALID_INPUT", `Invalid Initiative id: ${id}.`);
    const initiatives = await this.listInitiatives();
    const found = initiatives.find((initiative) => initiative.id === id);
    if (found === undefined) throw new CodepatrolError("WORK_NOT_FOUND", `Initiative not found: ${id}.`);
    return found;
  }

  /**
   * Links an observed Issue to the Work, on the manifest ref even once the Work
   * is terminal: the archive is the frozen code record and is never advanced,
   * while the manifest ref keeps carrying the Work's associations.
   */
  async linkIssue(workId: string, issue: WorkManifest["issue"]): Promise<ManifestRevision> {
    if (issue === null) throw new CodepatrolError("INVALID_INPUT", "An Issue link is required.");
    return withGitRefLock(this.workspace, `work/${workId}`, async () => {
      const current = await this.read(workId);
      if (current.manifest.issue?.repository === issue.repository && current.manifest.issue.number === issue.number) return current;
      if (current.manifest.issue !== null) throw new CodepatrolError("SYNC_CONFLICT", `Work ${workId} is already linked to another Issue.`);
      if (current.source !== "manifest") {
        throw new CodepatrolError("STATE_CONFLICT", `Work ${workId} has no writable manifest ref; synchronize its refs first.`);
      }
      const next = { ...current.manifest, issue };
      return this.write(current, next, `sync(${workId}): link issue #${issue.number}`);
    });
  }
}

function subjectOf(title: string): string {
  return title.replace(/[\r\n]+/g, " ").trim().slice(0, 72) || "work";
}
