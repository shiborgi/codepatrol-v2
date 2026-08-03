import assert from "node:assert/strict";
import test from "node:test";
import { CodepatrolError } from "../core/errors.js";
import { parseInitiativeDocument } from "../core/initiative-document.js";
import { diffInitiativeDocument, type InitiativeDiff } from "../core/initiative-diff.js";
import type { WorkManifest } from "../core/work-manifest.js";
import { CREATE_FIELDS, documentFixture, fixtureId, manifestFixture } from "./support/fixtures.js";

const INITIATIVE = "INIT-0";

function diff(manifests: readonly WorkManifest[], works: unknown[], overrides: Record<string, unknown> = {}): InitiativeDiff {
  return diffInitiativeDocument(parseInitiativeDocument(documentFixture(manifests, works, overrides)), manifests, INITIATIVE);
}

function rejects(manifests: readonly WorkManifest[], works: unknown[], code: string, overrides: Record<string, unknown> = {}): void {
  assert.throws(
    () => diff(manifests, works, overrides),
    (error: unknown) => error instanceof CodepatrolError
      && error.code === "DOCUMENT_REJECTED"
      && error.message.includes(`[${code}]`),
    `expected ${code}`,
  );
}

function parseRejects(document: unknown, fragment: string): void {
  assert.throws(
    () => parseInitiativeDocument(document),
    (error: unknown) => error instanceof CodepatrolError && error.code === "INVALID_DOCUMENT" && error.message.includes(fragment),
    fragment,
  );
}

test("refuses a document that is not well-formed", () => {
  const manifests = [manifestFixture("a")];
  parseRejects({ ...(documentFixture(manifests, []) as object), schemaVersion: 2 }, "schemaVersion is unsupported");
  parseRejects({ ...(documentFixture(manifests, []) as object), type: "something-else" }, "type is invalid");
  parseRejects({ ...(documentFixture(manifests, []) as object), surprise: true }, "unknown field: surprise");
  parseRejects(documentFixture(manifests, []), "declares nothing");
  parseRejects({ ...(documentFixture(manifests, []) as object), digest: "not-a-digest", works: [{ key: "one", ...CREATE_FIELDS }] }, "SHA-256");
});

test("refuses invalid Work declarations rather than coercing them", () => {
  const manifests = [manifestFixture("a")];
  parseRejects(documentFixture(manifests, [{ key: "one", ...CREATE_FIELDS, priority: "urgent" }]), "priority must be one of");
  parseRejects(documentFixture(manifests, [{ key: "one", ...CREATE_FIELDS, issueType: "Chore" }]), "issueType must be one of");
  parseRejects(documentFixture(manifests, [{ key: "one", ...CREATE_FIELDS, acceptance: [] }]), "non-empty array");
  parseRejects(documentFixture(manifests, [{ key: "One Key", ...CREATE_FIELDS }]), "must match");
  parseRejects(documentFixture(manifests, [{ key: "one", id: fixtureId("a"), ...CREATE_FIELDS }]), "cannot carry both");
  parseRejects(documentFixture(manifests, [{ ...CREATE_FIELDS }]), "must carry key");
});

test("accepts a document that declares only an Initiative", () => {
  // An Initiative is a thing to declare in its own right: the intent and the
  // shape of a breakdown can be recorded before the breakdown exists, which is
  // also how an Initiative delivered outside the backlog gets a local record.
  const manifests = [manifestFixture("a")];
  const document = parseInitiativeDocument(documentFixture(manifests, [], {
    initiative: { title: "Declared alone", intent: "i", motivation: "m", ordering: "o" },
  }));
  assert.deepEqual(document.works, []);
  assert.equal(document.initiative?.title, "Declared alone");
});

test("rejects a document written against a graph that has since moved", () => {
  const observed = [manifestFixture("a")];
  const actual = [manifestFixture("a"), manifestFixture("b")];
  const document = parseInitiativeDocument(documentFixture(observed, [{ key: "one", ...CREATE_FIELDS }]));
  assert.throws(
    () => diffInitiativeDocument(document, actual, INITIATIVE),
    (error: unknown) => error instanceof CodepatrolError && error.code === "DOCUMENT_REJECTED" && error.message.includes("[STALE_DOCUMENT]"),
  );
});

test("rejects duplicate keys and references to keys it does not create", () => {
  const manifests = [manifestFixture("a")];
  rejects(manifests, [
    { key: "one", ...CREATE_FIELDS },
    { key: "one", ...CREATE_FIELDS },
  ], "DUPLICATE_KEY");
  rejects(manifests, [{ id: fixtureId("a"), ...CREATE_FIELDS, title: "Work a", blockedBy: ["#ghost"] }], "UNKNOWN_KEY");
});

test("rejects documents naming a Work that does not exist locally", () => {
  const manifests = [manifestFixture("a")];
  rejects(manifests, [{ id: fixtureId("absent"), ...CREATE_FIELDS }], "UNKNOWN_WORK");
  rejects(manifests, [], "UNKNOWN_WORK", { cancel: [{ workId: fixtureId("absent"), reason: "why", authority: "owner" }] });
});

test("rejects a self-dependency", () => {
  const manifests = [manifestFixture("a")];
  rejects(manifests, [{ id: fixtureId("a"), ...CREATE_FIELDS, title: "Work a", blockedBy: [fixtureId("a")] }], "SELF_DEPENDENCY");
});

test("rejects a cycle the document would introduce, direct or transitive", () => {
  // Every non-terminal member of the Initiative must stay named, or Pass four
  // reads its absence as a drop rather than "unchanged" — and blockedBy is
  // part of that restated state too: omitting it declares "no blockers", not
  // "unchanged". Each Work's existing edges are restated verbatim except the
  // one new edge the cycle turns on.
  const direct = [manifestFixture("a", { blockedBy: ["b"] }), manifestFixture("b")];
  rejects(direct, [
    { id: fixtureId("a"), ...CREATE_FIELDS, title: "Work a", blockedBy: [fixtureId("b")] },
    { id: fixtureId("b"), ...CREATE_FIELDS, title: "Work b", blockedBy: [fixtureId("a")] },
  ], "GRAPH_CYCLE");

  const transitive = [manifestFixture("a", { blockedBy: ["b"] }), manifestFixture("b", { blockedBy: ["c"] }), manifestFixture("c")];
  rejects(transitive, [
    { id: fixtureId("a"), ...CREATE_FIELDS, title: "Work a", blockedBy: [fixtureId("b")] },
    { id: fixtureId("b"), ...CREATE_FIELDS, title: "Work b", blockedBy: [fixtureId("c")] },
    { id: fixtureId("c"), ...CREATE_FIELDS, title: "Work c", blockedBy: [fixtureId("a")] },
  ], "GRAPH_CYCLE");
});

test("rejects a cycle that only exists once the new Works land", () => {
  const manifests = [manifestFixture("a")];
  rejects(manifests, [
    { key: "one", ...CREATE_FIELDS, blockedBy: ["#two"] },
    { key: "two", ...CREATE_FIELDS, blockedBy: ["#one"] },
  ], "GRAPH_CYCLE");
});

test("rejects any mutation of a terminal Work", () => {
  for (const outcome of ["accepted", "rolled-back", "superseded", "cancelled"] as const) {
    const manifests = [manifestFixture("done", { outcome })];
    rejects(manifests, [{ id: fixtureId("done"), ...CREATE_FIELDS, title: "New" }], "PROTECTED_WORK");
    rejects(manifests, [], "PROTECTED_WORK", { cancel: [{ workId: fixtureId("done"), reason: "why", authority: "owner" }] });
  }
});

test("refuses to rewrite a Work that holds a candidate, but allows ending it", () => {
  for (const stage of ["build", "verify"] as const) {
    const manifests = [manifestFixture("running", { stage })];
    rejects(manifests, [{ id: fixtureId("running"), ...CREATE_FIELDS, title: "New" }], "PROTECTED_WORK");
    // Ending it is still permitted: destruction with authority stays explicit.
    assert.doesNotThrow(() => diff(manifests, [], { cancel: [{ workId: fixtureId("running"), reason: "abandoned", authority: "owner" }] }));
  }
});

test("refuses to refine a Work with a live run", () => {
  const manifests = [manifestFixture("running", { active: true })];
  rejects(manifests, [{ id: fixtureId("running"), ...CREATE_FIELDS, title: "New" }], "ACTIVE_WORK");
});

test("refuses a Work claimed by the document and an explicit termination at once", () => {
  const manifests = [manifestFixture("a")];
  rejects(manifests, [{ id: fixtureId("a"), ...CREATE_FIELDS, title: "Work a" }], "OVERLAPPING_ACTIONS", {
    cancel: [{ workId: fixtureId("a"), reason: "one", authority: "owner" }],
  });
});

test("drops a content-free Work the document no longer declares", () => {
  const manifests = [manifestFixture("a"), manifestFixture("gone")];
  const result = diff(manifests, [{ id: fixtureId("a"), ...CREATE_FIELDS, title: "Work a" }]);
  assert.deepEqual(result.terminations, [{
    workId: fixtureId("gone"),
    outcome: "cancelled",
    authority: "spec",
    summary: "Dropped by the initiative document.",
  }]);
});

test("refuses to drop a Work with content implicitly", () => {
  const manifests = [manifestFixture("a"), manifestFixture("gone", { started: true })];
  rejects(manifests, [{ id: fixtureId("a"), ...CREATE_FIELDS, title: "Work a" }], "DROPPED_WORK");
});

test("never touches terminal members the document does not declare", () => {
  const manifests = [manifestFixture("a"), manifestFixture("done", { outcome: "accepted" })];
  const result = diff(manifests, [{ id: fixtureId("a"), ...CREATE_FIELDS, title: "Work a" }]);
  assert.deepEqual(result.terminations, []);
});

test("plans a supersede with its replacements", () => {
  const manifests = [manifestFixture("big")];
  const result = diff(manifests, [
    { key: "one", ...CREATE_FIELDS, title: "First half" },
    { key: "two", ...CREATE_FIELDS, title: "Second half" },
  ], { supersede: [{ workId: fixtureId("big"), replacedBy: ["#one", "#two"], rationale: "too large", authority: "owner" }] });
  assert.equal(result.creates.length, 2);
  assert.deepEqual(result.terminations, [{
    workId: fixtureId("big"),
    outcome: "superseded",
    authority: "owner",
    summary: "too large",
    replacedBy: [{ kind: "key", key: "one" }, { kind: "key", key: "two" }],
  }]);
  assert.equal(result.counts.supersedes, 1);
  assert.equal(result.counts.creates, 2);
});

test("plans a follow-up that names the Work it came out of", () => {
  const manifests = [manifestFixture("done", { outcome: "accepted" })];
  const result = diff(manifests, [], { followUp: [{ key: "next", ...CREATE_FIELDS, from: fixtureId("done") }] });
  assert.deepEqual(result.creates.map((create) => create.followUpOf), [fixtureId("done")]);
});

test("computes dependency additions and removals from the declared edge set", () => {
  const manifests = [manifestFixture("a", { blockedBy: ["b"] }), manifestFixture("b"), manifestFixture("c")];
  const result = diff(manifests, [{ id: fixtureId("a"), ...CREATE_FIELDS, title: "Work a", blockedBy: [fixtureId("c")] }]);
  const update = result.updates.find((item) => item.workId === fixtureId("a"));
  assert.deepEqual(update?.blockedBy, [{ kind: "id", id: fixtureId("c") }]);
  assert.equal(result.counts.dependenciesAdded, 1);
  assert.equal(result.counts.dependenciesRemoved, 1);
});

test("reports every problem at once rather than only the first", () => {
  const manifests = [manifestFixture("a")];
  assert.throws(
    () => diff(manifests, [
      { id: fixtureId("absent"), ...CREATE_FIELDS },
      { id: fixtureId("a"), ...CREATE_FIELDS, title: "Work a", blockedBy: [fixtureId("a")] },
    ]),
    (error: unknown) => error instanceof CodepatrolError
      && error.message.includes("[UNKNOWN_WORK]")
      && error.message.includes("[SELF_DEPENDENCY]"),
  );
});
