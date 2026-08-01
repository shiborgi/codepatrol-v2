import assert from "node:assert/strict";
import test from "node:test";
import { CodepatrolError } from "../core/errors.js";
import { parseInitiative, serializeInitiative, slugOf, type Initiative } from "../core/initiative.js";
import { createTestApp, type TestApp } from "./support/app.js";
import { INITIATIVE_DOCUMENT_SCHEMA_VERSION, INITIATIVE_DOCUMENT_TYPE, parseInitiativeDocument, type InitiativeDocument } from "../core/initiative-document.js";
import { createTestRepo } from "./support/repo.js";
import { GitManifestStore } from "../adapters/manifest-store.js";
import { Worktrees, worktreeStoreHooks } from "../adapters/worktree.js";
import { CREATE_FIELDS } from "./support/fixtures.js";

function initiative(overrides: Partial<Initiative> = {}): Initiative {
  return {
    schemaVersion: 1,
    type: "codepatrol-initiative",
    id: "INIT-0",
    title: "Initiative and Work Graph",
    slug: "initiative-and-work-graph",
    intent: "Introduce the Initiative.",
    motivation: "The backlog should read itself.",
    ordering: "Identity first, then the document.",
    createdAt: "2026-08-03T00:00:00.000Z",
    ...overrides,
  };
}

async function documentFor(app: TestApp, works: unknown[], extra: Record<string, unknown> = {}): Promise<InitiativeDocument> {
  const inspection = await app.spec.inspect();
  return parseInitiativeDocument({
    schemaVersion: INITIATIVE_DOCUMENT_SCHEMA_VERSION,
    type: INITIATIVE_DOCUMENT_TYPE,
    documentId: "document-init",
    summary: "Initiative fixture",
    observedState: "fixture",
    digest: inspection.digest,
    createdAt: "2026-08-03T00:00:00.000Z",
    works,
    ...extra,
  });
}

test("parses an Initiative strictly and refuses unknown or missing fields", () => {
  const parsed = parseInitiative(JSON.parse(serializeInitiative(initiative())));
  assert.equal(parsed.id, "INIT-0");
  assert.equal(parsed.slug, "initiative-and-work-graph");

  const raw = JSON.parse(serializeInitiative(initiative())) as Record<string, unknown>;
  assert.throws(() => parseInitiative({ ...raw, surprise: true }), (error: unknown) => error instanceof CodepatrolError && error.code === "STATE_CORRUPT");
  const missing = { ...raw } as Record<string, unknown>;
  delete missing.motivation;
  assert.throws(() => parseInitiative(missing), (error: unknown) => error instanceof CodepatrolError && error.code === "STATE_CORRUPT");
  assert.throws(() => parseInitiative({ ...raw, id: "INIT-x" }), (error: unknown) => error instanceof CodepatrolError && error.code === "STATE_CORRUPT");
  assert.throws(() => parseInitiative({ ...raw, schemaVersion: 99 }), (error: unknown) => error instanceof CodepatrolError && error.code === "STATE_CORRUPT");
});

test("mints sequential Initiative numbers inside the apply transaction", async () => {
  const app = await createTestApp({ defaultBranch: "trunk" });
  try {
    const first = await app.spec.apply(await documentFor(app, [{ key: "one", ...CREATE_FIELDS, title: "First" }], {
      initiative: { title: "First initiative", intent: "i", motivation: "m", ordering: "o" },
    }));
    assert.equal(first.initiative, "INIT-0");

    const second = await app.spec.apply(await documentFor(app, [{ key: "two", ...CREATE_FIELDS, title: "Second" }], {
      initiative: { title: "Second initiative", intent: "i", motivation: "m", ordering: "o" },
    }));
    assert.equal(second.initiative, "INIT-1", "the next free number is minted");

    const listed = await app.initiatives.list();
    assert.deepEqual(listed.map((item) => item.id), ["INIT-0", "INIT-1"]);
    const shown = await app.initiatives.show("INIT-0");
    assert.equal(shown.initiative.title, "First initiative");
    assert.equal(shown.initiative.intent, "i");
    assert.equal(shown.initiative.motivation, "m");
    assert.equal(shown.initiative.ordering, "o");
  } finally {
    await app.cleanup();
  }
});

test("a failed apply mints no Initiative", async () => {
  const app = await createTestApp({ defaultBranch: "trunk" });
  try {
    const proposal = await documentFor(app, [], {
      initiative: { title: "Never mint", intent: "i", motivation: "m", ordering: "o" },
      cancel: [{ workId: "INIT-0.9-absent", reason: "gone", authority: "owner" }],
    });
    await assert.rejects(app.spec.apply(proposal), (error: unknown) => error instanceof CodepatrolError && error.code === "DOCUMENT_REJECTED");
    assert.deepEqual(await app.initiatives.list(), [], "nothing was minted by the refused apply");
  } finally {
    await app.cleanup();
  }
});

test("initiative show derives membership from identifiers and changes nothing", async () => {
  const app = await createTestApp({ defaultBranch: "trunk" });
  try {
    const applied = await app.spec.apply(await documentFor(app, [{ key: "one", ...CREATE_FIELDS, title: "Member Work" }], {
      initiative: { title: "Membership", intent: "i", motivation: "m", ordering: "o" },
    }));
    const workId = (applied.createdWorkIds ?? [])[0] as string;
    const before = await app.repo.head("refs/heads/trunk");
    const shown = await app.initiatives.show(applied.initiative as string);
    // Membership is derived from the identifier, never stored: the Work names
    // its Initiative, and reading it back writes nothing.
    assert.deepEqual(shown.works.map((work) => work.id), [workId]);
    assert.ok(workId.startsWith(`${applied.initiative}.`));
    assert.equal(await app.repo.head("refs/heads/trunk"), before);
    await assert.rejects(app.initiatives.show("INIT-9"), (error: unknown) => error instanceof CodepatrolError && error.code === "WORK_NOT_FOUND");
    await assert.rejects(app.initiatives.show("bogus"), (error: unknown) => error instanceof CodepatrolError && error.code === "INVALID_INPUT");
  } finally {
    await app.cleanup();
  }
});

test("slugOf is deterministic and ref-safe", () => {
  assert.equal(slugOf("Initiative and Work Graph!"), "initiative-and-work-graph");
  assert.equal(slugOf("  --Weird -- title--  "), "weird-title");
  assert.equal(slugOf("///"), "work");
  assert.equal(slugOf("a".repeat(80)).length, 48);
});

test("an Initiative lives in its own ref with no branch", async () => {
  const repo = await createTestRepo({ defaultBranch: "trunk" });
  try {
    const worktrees = new Worktrees(repo.root);
    const store = new GitManifestStore(repo.root, worktreeStoreHooks(worktrees));
    const { initiative: minted } = await store.applyBatch({
      initiative: initiative({ title: "Local object", slug: "local-object" }),
      creates: [],
      writes: [],
      archives: [],
      subject: "spec: fixture",
    });
    assert.ok(minted);
    assert.equal(minted.id, "INIT-0");
    const ref = `refs/codepatrol/initiative/INIT-0-${minted.slug}`;
    assert.notEqual(await repo.git("rev-parse", "--verify", "--quiet", ref), "");
    const stored = JSON.parse(await repo.git("show", `${ref}:initiative.json`)) as Record<string, unknown>;
    assert.equal(stored.title, "Local object");
    assert.equal(await repo.refExists("refs/heads/codepatrol/initiative/INIT-0-local-object"), false, "no branch is created");
  } finally {
    await repo.cleanup();
  }
});
