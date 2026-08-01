import assert from "node:assert/strict";
import test from "node:test";
import { CodepatrolError } from "../core/errors.js";
import { INITIATIVE_DOCUMENT_SCHEMA_VERSION, INITIATIVE_DOCUMENT_TYPE, parseInitiativeDocument, type InitiativeDocument } from "../core/initiative-document.js";
import { archiveRef, workBranchRef, manifestRef } from "../core/work-manifest.js";
import { createTestApp, type TestApp } from "./support/app.js";
import { CREATE_FIELDS } from "./support/fixtures.js";

async function documentFor(app: TestApp, works: unknown[], overrides: Record<string, unknown> = {}): Promise<InitiativeDocument> {
  const inspection = await app.spec.inspect();
  // A Work cannot exist without an Initiative: the first apply of a test
  // declares one unless the test supplies its own declaration.
  const declared = "initiative" in overrides || (await app.initiatives.list()).length > 0;
  return parseInitiativeDocument({
    schemaVersion: INITIATIVE_DOCUMENT_SCHEMA_VERSION,
    type: INITIATIVE_DOCUMENT_TYPE,
    documentId: "document-9f73",
    summary: "Add passkey authentication",
    observedState: inspection.graph.nodes.map((node) => `${node.id} ${node.status}`).join("; ") || "empty backlog",
    digest: inspection.digest,
    createdAt: "2026-07-31T05:00:00.000Z",
    works,
    ...(declared ? {} : { initiative: { title: "Fixture initiative", intent: "i", motivation: "m", ordering: "o" } }),
    ...overrides,
  });
}

test("applies a multi-Work document as one transaction and links its siblings", async () => {
  const app = await createTestApp({ defaultBranch: "trunk" });
  try {
    const document = await documentFor(app, [
      { key: "schema", ...CREATE_FIELDS, title: "Add credential schema" },
      { key: "endpoint", ...CREATE_FIELDS, title: "Add registration endpoint", blockedBy: ["#schema"] },
      { key: "ui", ...CREATE_FIELDS, title: "Add enrolment UI", blockedBy: ["#endpoint"] },
    ], { initiative: { title: "Passkey authentication", intent: "Add passkeys", motivation: "Split by verification boundary", ordering: "Schema before endpoints, endpoints before UI" } });

    const dry = await app.spec.validate(document);
    assert.equal(dry.nextCommand, "codepatrol spec apply --initiative <the same file>", "a dry run reports without writing");
    assert.deepEqual(await app.works.list(), [], "validate mutated nothing");

    const applied = await app.spec.apply(document);
    const created = applied.createdWorkIds ?? [];
    assert.equal(created.length, 3);
    assert.equal(applied.creates, 3);

    const graph = await app.works.graph();
    assert.equal(graph.nodes.length, 3);
    assert.deepEqual(graph.executable, [created[0] as string].sort(), "only the unblocked Work is executable");

    // Every created Work exists on its manifest ref alone: no branch, because
    // no content exists yet.
    for (const workId of created) {
      assert.equal(await app.repo.refExists(manifestRef(workId)), true, workId);
      assert.equal(await app.repo.refExists(workBranchRef(workId)), false, workId);
    }

    // Every created Work names its Initiative, and positions follow the
    // topological order they were created in.
    for (const workId of created) {
      const view = await app.works.show(workId);
      assert.equal(view.identity.initiative.id, applied.initiative);
      assert.ok(workId.startsWith(`${applied.initiative}.`), "the identifier names its home");
      assert.deepEqual(view.identity.acceptance, CREATE_FIELDS.acceptance);
    }
    const positions = created.map((workId) => Number(workId.split("-")[0]?.split(".")[1]));
    assert.deepEqual(positions, [...positions].sort((left, right) => left - right), "positions are assigned in topological order");
  } finally {
    await app.cleanup();
  }
});

test("a rejected document leaves the repository exactly as it was", async () => {
  const app = await createTestApp({ defaultBranch: "trunk" });
  try {
    const before = await app.repo.head("refs/heads/trunk");
    // The creates are fine; the cancel is not, so nothing may land.
    const document = await documentFor(app, [
      { key: "one", ...CREATE_FIELDS, title: "First" },
      { key: "two", ...CREATE_FIELDS, title: "Second" },
    ], { cancel: [{ workId: "INIT-0.9-absent", reason: "does not exist", authority: "owner" }] });

    await assert.rejects(
      app.spec.apply(document),
      (error: unknown) => error instanceof CodepatrolError && error.code === "DOCUMENT_REJECTED",
    );

    assert.deepEqual(await app.works.list(), [], "no Work was created by the valid half of the document");
    assert.equal(await app.repo.head("refs/heads/trunk"), before);
  } finally {
    await app.cleanup();
  }
});

test("refuses a document once the graph has moved underneath it", async () => {
  const app = await createTestApp({ defaultBranch: "trunk" });
  try {
    const document = await documentFor(app, [{ key: "one", ...CREATE_FIELDS, title: "First" }]);
    // Someone else changed the backlog between inspection and application.
    await app.spec.apply(await documentFor(app, [{ key: "other", ...CREATE_FIELDS, title: "Unrelated" }]));

    await assert.rejects(
      app.spec.apply(document),
      (error: unknown) => error instanceof CodepatrolError && error.message.includes("[STALE_DOCUMENT]"),
    );
    assert.equal((await app.works.list()).length, 1);
  } finally {
    await app.cleanup();
  }
});

test("supersede archives the original and stops it executing", async () => {
  const app = await createTestApp({ defaultBranch: "trunk" });
  try {
    const seeded = await app.spec.apply(await documentFor(app, [
      { key: "original", ...CREATE_FIELDS, title: "Do everything at once" },
    ]));
    const original = (seeded.createdWorkIds ?? [])[0] as string;

    const split = await app.spec.apply(await documentFor(app, [
      { key: "first", ...CREATE_FIELDS, title: "First half" },
      { key: "second", ...CREATE_FIELDS, title: "Second half" },
    ], { supersede: [{ workId: original, replacedBy: ["#first", "#second"], rationale: "two verification boundaries", authority: "release-owner" }] }));

    const view = await app.works.show(original);
    assert.equal(view.outcome, "superseded");
    assert.equal(view.graph.status, "superseded");
    assert.equal(view.source, "manifest", "the manifest ref carries the terminal record");
    assert.equal(await app.repo.refExists(workBranchRef(original)), false, "a Work with no content never owned a branch");
    assert.equal(await app.repo.refExists(archiveRef(original)), false, "and leaves no archive behind");
    // The original names its replacements, so the split is traceable forwards.
    assert.deepEqual([...(view.replacedBy ?? [])].sort(), [...(split.createdWorkIds ?? [])].sort());

    // A superseded Work cannot be executed.
    await assert.rejects(
      app.works.start("plan", original, "h", "m", [{ id: "T1", title: "Plan it" }]),
      (error: unknown) => error instanceof CodepatrolError && error.code === "INVALID_TRANSITION",
    );
    assert.equal(await app.repo.commitCount("refs/heads/trunk"), 1, "no Spec decision ever touches the base");
  } finally {
    await app.cleanup();
  }
});

test("a Work cancelled without content terminalizes with no branch at all", async () => {
  const app = await createTestApp({ defaultBranch: "trunk" });
  try {
    const seeded = await app.spec.apply(await documentFor(app, [
      { key: "doomed", ...CREATE_FIELDS, title: "Never started" },
    ]));
    const workId = (seeded.createdWorkIds ?? [])[0] as string;
    await app.spec.apply(await documentFor(app, [], {
      cancel: [{ workId, reason: "the premise no longer holds", authority: "release-owner" }],
    }));

    const view = await app.works.show(workId);
    assert.equal(view.outcome, "cancelled");
    assert.equal(view.source, "manifest", "the Work remains fully readable from its manifest ref");
    assert.equal(await app.repo.refExists(workBranchRef(workId)), false, "it never had a branch");
    assert.equal(await app.repo.refExists(archiveRef(workId)), false, "and leaves no archive behind");
  } finally {
    await app.cleanup();
  }
});

test("a Work cancelled with an opened branch ends with exactly one branch, archived", async () => {
  const app = await createTestApp({ defaultBranch: "trunk" });
  try {
    const seeded = await app.spec.apply(await documentFor(app, [
      { key: "doomed", ...CREATE_FIELDS, title: "Started but abandoned" },
    ]));
    const workId = (seeded.createdWorkIds ?? [])[0] as string;
    await app.runThrough(workId, "review");
    const started = await app.works.start("build", workId, "h", "m", [{ id: "T1", title: "Build it" }]);
    const branchHead = await app.repo.head(workBranchRef(workId));

    await app.spec.apply(await documentFor(app, [], {
      cancel: [{ workId, reason: "the premise no longer holds", authority: "release-owner" }],
    }));

    const view = await app.works.show(workId);
    assert.equal(view.outcome, "cancelled");
    assert.equal(await app.repo.refExists(workBranchRef(workId)), false, "the working name is gone");
    assert.equal(await app.repo.head(archiveRef(workId)), branchHead, "the same commit survives under the archive name");
    assert.equal((await app.works.show(workId)).attempts.at(-1)?.runId, started.runId);
  } finally {
    await app.cleanup();
  }
});

test("cancel ends a Work with a live run without losing its evidence", async () => {
  const app = await createTestApp({ defaultBranch: "trunk" });
  try {
    const seeded = await app.spec.apply(await documentFor(app, [
      { key: "doomed", ...CREATE_FIELDS, title: "Abandoned direction" },
    ]));
    const workId = (seeded.createdWorkIds ?? [])[0] as string;
    const started = await app.works.start("plan", workId, "h", "m", [{ id: "T1", title: "Plan it" }]);

    const cancelled = await app.spec.apply(await documentFor(app, [], {
      cancel: [{ workId, reason: "the premise no longer holds", authority: "release-owner" }],
    }));
    assert.deepEqual(cancelled.terminatedWorkIds, [workId]);

    const view = await app.works.show(workId);
    assert.equal(view.outcome, "cancelled");
    const attempt = view.attempts.at(-1);
    assert.equal(attempt?.runId, started.runId);
    assert.equal(attempt?.status, "abandoned", "the run is preserved but never counts as a conclusion");
    assert.equal(attempt?.result, undefined);
  } finally {
    await app.cleanup();
  }
});

test("applies a dependency change and refuses one that would cycle", async () => {
  const app = await createTestApp({ defaultBranch: "trunk" });
  try {
    const seeded = await app.spec.apply(await documentFor(app, [
      { key: "one", ...CREATE_FIELDS, title: "Foundation" },
      { key: "two", ...CREATE_FIELDS, title: "Dependent" },
    ]));
    const [first, second] = seeded.createdWorkIds as [string, string];

    // The document states the whole shape; the diff computes the added edge.
    const linked = await app.spec.apply(await documentFor(app, [
      { id: first, ...CREATE_FIELDS, title: "Foundation" },
      { id: second, ...CREATE_FIELDS, title: "Dependent", blockedBy: [first] },
    ]));
    assert.equal(linked.dependenciesAdded, 1);
    assert.deepEqual((await app.works.show(second)).graph.blockedBy, [first]);

    await assert.rejects(
      app.spec.apply(await documentFor(app, [
        { id: first, ...CREATE_FIELDS, title: "Foundation", blockedBy: [second] },
        { id: second, ...CREATE_FIELDS, title: "Dependent", blockedBy: [first] },
      ])),
      (error: unknown) => error instanceof CodepatrolError && error.message.includes("[GRAPH_CYCLE]"),
    );
    assert.deepEqual((await app.works.show(first)).graph.blockedBy, [], "the refused edge was never written");
  } finally {
    await app.cleanup();
  }
});

test("merges two Works into one, uniting their dependencies", async () => {
  const app = await createTestApp({ defaultBranch: "trunk" });
  try {
    const seeded = await app.spec.apply(await documentFor(app, [
      { key: "dep", ...CREATE_FIELDS, title: "Shared foundation" },
      { key: "left", ...CREATE_FIELDS, title: "Left half", blockedBy: ["#dep"] },
      { key: "right", ...CREATE_FIELDS, title: "Right half" },
    ]));
    const [dep, left, right] = seeded.createdWorkIds as [string, string, string];

    // The merge is the document's final shape: the destination carries the
    // united scope and dependencies, and the other source is superseded.
    const merged = await app.spec.apply(await documentFor(app, [
      { id: dep, ...CREATE_FIELDS, title: "Shared foundation" },
      {
        id: left, ...CREATE_FIELDS,
        title: "One coherent change",
        description: "The halves were inseparable",
        acceptance: ["Both behaviours hold together"],
        blockedBy: [dep],
      },
    ], { supersede: [{ workId: right, replacedBy: [left], rationale: "separate integration would leave the repository invalid", authority: "release-owner" }] }));

    assert.deepEqual(merged.terminatedWorkIds, [right]);
    const destination = await app.works.show(left);
    assert.equal(destination.identity.title, "One coherent change");
    assert.deepEqual(destination.identity.acceptance, ["Both behaviours hold together"]);
    assert.deepEqual(destination.graph.blockedBy, [dep], "the union of both sources' dependencies");

    const source = await app.works.show(right);
    assert.equal(source.outcome, "superseded");
    assert.deepEqual(source.replacedBy, [left]);
  } finally {
    await app.cleanup();
  }
});

test("creates a follow-up that names the Work it came out of", async () => {
  const app = await createTestApp({ defaultBranch: "trunk" });
  try {
    const seeded = await app.spec.apply(await documentFor(app, [
      { key: "original", ...CREATE_FIELDS, title: "First pass" },
    ]));
    const original = (seeded.createdWorkIds ?? [])[0] as string;
    await app.runThrough(original, "ship");

    // A terminal Work is immutable, but it can still be the origin of new Work.
    const followed = await app.spec.apply(await documentFor(app, [], {
      followUp: [{ key: "residual", ...CREATE_FIELDS, title: "Handle the residual risk", from: original }],
    }));
    const followUp = (followed.createdWorkIds ?? [])[0] as string;
    assert.equal((await app.works.show(followUp)).graph.status, "executable");
    assert.equal((await app.works.show(original)).outcome, "accepted", "the terminal Work is untouched");
  } finally {
    await app.cleanup();
  }
});

test("drops a content-free Work the document no longer declares", async () => {
  const app = await createTestApp({ defaultBranch: "trunk" });
  try {
    const seeded = await app.spec.apply(await documentFor(app, [
      { key: "keeper", ...CREATE_FIELDS, title: "Stays" },
      { key: "gone", ...CREATE_FIELDS, title: "Goes quietly" },
    ]));
    const [keeper, gone] = seeded.createdWorkIds as [string, string];

    const applied = await app.spec.apply(await documentFor(app, [
      { id: keeper, ...CREATE_FIELDS, title: "Stays" },
    ]));

    assert.deepEqual(applied.terminatedWorkIds, [gone]);
    assert.equal((await app.works.show(gone)).outcome, "cancelled", "an implicit drop is a cancellation");
  } finally {
    await app.cleanup();
  }
});

test("refuses to drop a Work with content implicitly", async () => {
  const app = await createTestApp({ defaultBranch: "trunk" });
  try {
    const seeded = await app.spec.apply(await documentFor(app, [
      { key: "keeper", ...CREATE_FIELDS, title: "Stays" },
      { key: "started", ...CREATE_FIELDS, title: "Has content" },
    ]));
    const [keeper, started] = seeded.createdWorkIds as [string, string];
    await app.runStage("plan", started);

    await assert.rejects(
      app.spec.apply(await documentFor(app, [
        { id: keeper, ...CREATE_FIELDS, title: "Stays" },
      ])),
      (error: unknown) => error instanceof CodepatrolError && error.message.includes("[DROPPED_WORK]"),
    );
    assert.equal((await app.works.show(started)).state, "ready", "the refused drop changed nothing");
  } finally {
    await app.cleanup();
  }
});
