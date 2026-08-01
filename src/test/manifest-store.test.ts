import assert from "node:assert/strict";
import test from "node:test";
import { GitManifestStore } from "../adapters/manifest-store.js";
import { CodepatrolError } from "../core/errors.js";
import { applyTransition } from "../core/lifecycle.js";
import { STAGE_ROLES } from "../core/types.js";
import { archiveRef, manifestPath, manifestRef, serializeManifest, workBranchRef, type WorkManifest } from "../core/work-manifest.js";
import { TEST_ORIGIN } from "./support/fixtures.js";
import { createTestRepo, type TestRepo } from "./support/repo.js";

const IDENTITY = {
  id: "INIT-0.1-fix-authentication",
  title: "Fix authentication",
  description: "Correct token refresh",
  issueType: "Task" as const,
  priority: "p1" as const,
  acceptance: ["The behaviour is demonstrably correct"],
  createdAt: "2026-07-31T03:00:00.000Z",
  requestedBy: "local-user",
  initiative: { id: "INIT-0", position: 1 },
  origin: TEST_ORIGIN,
};

function otherIdentity(id: string) {
  // The creation date is older than IDENTITY's, so "newest first" is
  // meaningful rather than resolved by the tie-break.
  return { ...IDENTITY, id, title: `Work ${id}`, createdAt: "2026-07-30T03:00:00.000Z", initiative: { id: "INIT-0", position: 2 } };
}

function planned(revision: { manifest: WorkManifest }): WorkManifest {
  return applyTransition(revision.manifest, {
    type: "start",
    stage: "plan",
    runId: "11111111-1111-4111-8111-111111111111",
    execution: { role: STAGE_ROLES.plan, harness: "test", model: "test-model" },
    todo: [{ id: "T1", title: "Plan it" }],
    at: "2026-07-31T03:05:00.000Z",
  });
}

async function store(repo: TestRepo): Promise<GitManifestStore> {
  return new GitManifestStore(repo.root);
}

async function create(subject: GitManifestStore, identity = IDENTITY) {
  const { revisions } = await subject.applyBatch({ creates: [{ identity, blockedBy: [] }], writes: [], archives: [], subject: "test fixture" });
  const revision = revisions[0];
  assert.ok(revision);
  return revision;
}

test("creates a Work as one manifest ref, with no branch and nothing on the base", async () => {
  const repo = await createTestRepo({ defaultBranch: "trunk" });
  try {
    const base = await repo.head();
    const revision = await create(await store(repo), IDENTITY);

    assert.equal(revision.source, "manifest");
    assert.equal(revision.manifest.repository.baseRef, "refs/heads/trunk");
    assert.equal(revision.manifest.repository.createdFromCommit, undefined, "a branchless Work has no provenance yet");
    assert.equal(revision.manifest.repository.baselineCommit, undefined, "a branchless Work has no baseline yet");
    assert.equal(revision.manifest.work.issueType, "Task");
    assert.equal(revision.codeHead, undefined, "no code exists yet");
    assert.equal(await repo.head(manifestRef(IDENTITY.id)), revision.commit);
    // No branch, the base untouched, and no worktree.
    await assert.rejects(repo.head(workBranchRef(IDENTITY.id)));
    assert.equal(await repo.head("refs/heads/trunk"), base);
    assert.equal(await repo.commitCount("refs/heads/trunk"), 1);
    assert.equal(await repo.showFile("refs/heads/trunk", manifestPath(IDENTITY.id)), undefined);
    assert.equal(await repo.git("worktree", "list", "--porcelain"), `worktree ${await repo.git("rev-parse", "--show-toplevel")}\nHEAD ${base}\nbranch refs/heads/trunk`);
    assert.ok((await repo.messageLines(revision.commit)).includes(`Codepatrol-Work: ${IDENTITY.id}`));
  } finally {
    await repo.cleanup();
  }
});

test("refuses to create a Work whose manifest ref already exists", async () => {
  const repo = await createTestRepo();
  try {
    const subject = await store(repo);
    await create(subject, IDENTITY);
    await assert.rejects(
      create(subject, IDENTITY),
      (error: unknown) => error instanceof CodepatrolError && error.code === "STATE_CONFLICT",
    );
  } finally {
    await repo.cleanup();
  }
});

test("advances the manifest ref on every write", async () => {
  const repo = await createTestRepo();
  try {
    const subject = await store(repo);
    const created = await create(subject, IDENTITY);

    const advanced = await subject.update(IDENTITY.id, planned, "plan(start)");
    assert.notEqual(advanced.commit, created.commit);
    assert.equal(advanced.manifest.workflow.state, "active");
    assert.equal(advanced.manifest.attempts.length, 1);
    assert.equal(await repo.head(manifestRef(IDENTITY.id)), advanced.commit);
    assert.equal((await subject.read(IDENTITY.id)).manifest.workflow.state, "active");
    assert.equal(await repo.commitCount(manifestRef(IDENTITY.id)), 3);
  } finally {
    await repo.cleanup();
  }
});

test("persists an Issue link in the manifest without rewriting it on repeat", async () => {
  const repo = await createTestRepo();
  try {
    const subject = await store(repo);
    await create(subject, IDENTITY);

    const linked = await subject.linkIssue(IDENTITY.id, { repository: "acme/widget", number: 7 });
    const repeated = await subject.linkIssue(IDENTITY.id, { repository: "acme/widget", number: 7 });

    assert.deepEqual(linked.manifest.issue, { repository: "acme/widget", number: 7 });
    assert.deepEqual((await subject.read(IDENTITY.id)).manifest.issue, { repository: "acme/widget", number: 7 });
    assert.equal(repeated.commit, linked.commit);
  } finally {
    await repo.cleanup();
  }
});

test("refuses a write whose expected commit is stale", async () => {
  const repo = await createTestRepo();
  try {
    const subject = await store(repo);
    const stale = await create(subject, IDENTITY);
    await subject.update(IDENTITY.id, planned, "plan(start)");

    await assert.rejects(
      subject.write(stale, planned(stale), "plan(start) again"),
      (error: unknown) => error instanceof CodepatrolError && error.code === "STATE_CONFLICT",
    );
  } finally {
    await repo.cleanup();
  }
});

test("resolves from the archive or the base when the manifest ref has not been fetched", async () => {
  const repo = await createTestRepo();
  try {
    const subject = await store(repo);
    const created = await create(subject, IDENTITY);
    const manifest = created.manifest;

    // Stand in for a clone that fetched branches and the base but not the
    // manifest ref: the record is still readable, from the base for an
    // accepted Work and from the archive for a rolled-back one.
    await repo.write(manifestPath(IDENTITY.id), serializeManifest(manifest));
    await repo.commit(`${IDENTITY.id}: integrate\n\nCodepatrol-Work: ${IDENTITY.id}`);
    const integration = await repo.head();
    await repo.git("update-ref", "-d", manifestRef(IDENTITY.id));

    const fromBase = await subject.read(IDENTITY.id);
    assert.equal(fromBase.source, "base");
    assert.equal(fromBase.commit, integration);

    const rolled = otherIdentity("INIT-0.2-rolled-back");
    const rolledRevision = await create(subject, rolled);
    await repo.git("update-ref", archiveRef(rolled.id), rolledRevision.commit);
    await repo.git("update-ref", "-d", manifestRef(rolled.id));

    const fromArchive = await subject.read(rolled.id);
    assert.equal(fromArchive.source, "archive");
    assert.equal(fromArchive.manifest.work.id, rolled.id);
  } finally {
    await repo.cleanup();
  }
});

test("keeps reading a Work whose branch was deleted, because the manifest ref remains", async () => {
  const repo = await createTestRepo();
  try {
    const subject = await store(repo);
    const created = await create(subject, IDENTITY);
    // A branch appears with content; deleting it loses the code, never the Work.
    await repo.git("update-ref", workBranchRef(IDENTITY.id), created.commit);
    await repo.git("update-ref", "-d", workBranchRef(IDENTITY.id));

    const reread = await subject.read(IDENTITY.id);
    assert.equal(reread.source, "manifest");
    assert.equal(reread.manifest.work.id, IDENTITY.id);
    assert.equal(reread.codeHead, undefined);
    assert.deepEqual((await subject.list()).map((revision) => revision.manifest.work.id), [IDENTITY.id]);
  } finally {
    await repo.cleanup();
  }
});

test("refuses to write a Work resolved without its manifest ref", async () => {
  const repo = await createTestRepo();
  try {
    const subject = await store(repo);
    const created = await create(subject, IDENTITY);
    await repo.git("update-ref", archiveRef(IDENTITY.id), created.commit);
    await repo.git("update-ref", "-d", manifestRef(IDENTITY.id));

    const archived = await subject.read(IDENTITY.id);
    assert.equal(archived.source, "archive");
    await assert.rejects(
      subject.write(archived, planned(archived), "plan(start)"),
      (error: unknown) => error instanceof CodepatrolError && error.code === "STATE_CONFLICT",
    );
  } finally {
    await repo.cleanup();
  }
});

test("lists Works across manifest refs, the base, and archives without duplicates", async () => {
  const repo = await createTestRepo();
  try {
    const subject = await store(repo);
    const open = await create(subject, IDENTITY);
    const archived = await create(subject, otherIdentity("INIT-0.2-archived"));

    await repo.git("update-ref", archiveRef(archived.manifest.work.id), archived.commit);
    await repo.git("update-ref", "-d", manifestRef(archived.manifest.work.id));
    // The open Work also appears in the base, which must not duplicate it.
    await repo.write(manifestPath(IDENTITY.id), serializeManifest(open.manifest));
    await repo.commit("integrate open work");

    const listed = await subject.list();
    assert.deepEqual(listed.map((revision) => revision.manifest.work.id), [IDENTITY.id, "INIT-0.2-archived"]);
    assert.equal(listed[0]?.source, "manifest", "the manifest ref wins over the base copy");
    assert.equal(listed[1]?.source, "archive");
  } finally {
    await repo.cleanup();
  }
});

test("reports a missing Work and an invalid id distinctly", async () => {
  const repo = await createTestRepo();
  try {
    const subject = await store(repo);
    await assert.rejects(
      subject.read("INIT-0.9-absent"),
      (error: unknown) => error instanceof CodepatrolError && error.code === "WORK_NOT_FOUND",
    );
    await assert.rejects(
      subject.read("not-a-work-id"),
      (error: unknown) => error instanceof CodepatrolError && error.code === "INVALID_WORK_ID",
    );
  } finally {
    await repo.cleanup();
  }
});
