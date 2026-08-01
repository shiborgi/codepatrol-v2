import assert from "node:assert/strict";
import test from "node:test";
import { CodepatrolError } from "../core/errors.js";
import type { WorkOutcome } from "../core/types.js";
import { assertAcyclic, assertBuildUnblocked, buildGraph, edgesOf, releasesDependents, transitiveBlockers } from "../core/work-graph.js";
import type { WorkManifest } from "../core/work-manifest.js";
import { TEST_ORIGIN } from "./support/fixtures.js";

const COMMIT = "a".repeat(40);

function id(name: string): string {
  return `INIT-0.1-${name}`;
}

/**
 * A manifest shaped only as far as the graph reads it. The graph never parses,
 * so building the full lifecycle history here would only obscure what is under
 * test.
 */
function work(name: string, options: { blockedBy?: string[]; outcome?: WorkOutcome; active?: boolean } = {}): WorkManifest {
  return {
    schemaVersion: 1,
    type: "codepatrol-work",
    work: {
      id: id(name),
      title: `Work ${name}`,
      description: "",
      issueType: "Task",
      priority: "p2",
      acceptance: ["It works"],
      createdAt: "2026-07-31T03:00:00.000Z",
      requestedBy: "local-user",
      initiative: { id: "INIT-0", position: 1 },
      origin: TEST_ORIGIN,
    },
    repository: { baseRef: "refs/heads/main", createdFromCommit: COMMIT, baselineCommit: COMMIT },
    graph: { blockedBy: (options.blockedBy ?? []).map(id).sort() },
    issue: null,
    workflow: { state: options.outcome === undefined ? (options.active === true ? "active" : "ready") : "terminal", stage: "plan", attempt: 1, updatedAt: "2026-07-31T03:00:00.000Z" },
    attempts: [],
    completion: options.outcome === undefined ? null : {
      outcome: options.outcome,
      via: options.outcome === "accepted" || options.outcome === "rolled-back" ? "ship" : "spec",
      authority: "release-owner",
      finalizedAt: "2026-07-31T04:00:00.000Z",
      summary: "done",
      ...(options.outcome === "superseded" ? { replacedBy: [id("replacement")] } : {}),
    },
  };
}

test("rejects a direct dependency cycle and names the Works in it", () => {
  const edges = edgesOf([work("a", { blockedBy: ["b"] }), work("b", { blockedBy: ["a"] })]);
  assert.throws(
    () => assertAcyclic(edges),
    (error: unknown) => error instanceof CodepatrolError && error.code === "GRAPH_CYCLE" && error.message.includes(id("a")) && error.message.includes(id("b")),
  );
});

test("rejects a transitive dependency cycle", () => {
  const edges = edgesOf([
    work("a", { blockedBy: ["b"] }),
    work("b", { blockedBy: ["c"] }),
    work("c", { blockedBy: ["a"] }),
  ]);
  assert.throws(() => assertAcyclic(edges), (error: unknown) => error instanceof CodepatrolError && error.code === "GRAPH_CYCLE");
});

test("accepts a diamond, which shares a blocker without cycling", () => {
  const edges = edgesOf([
    work("base"),
    work("left", { blockedBy: ["base"] }),
    work("right", { blockedBy: ["base"] }),
    work("top", { blockedBy: ["left", "right"] }),
  ]);
  assert.doesNotThrow(() => assertAcyclic(edges));
  assert.deepEqual([...transitiveBlockers(edges, id("top"))].sort(), [id("base"), id("left"), id("right")].sort());
});

test("only an accepted blocker releases its dependents", () => {
  for (const outcome of ["rolled-back", "superseded", "cancelled"] as const) {
    assert.equal(releasesDependents(work("blocker", { outcome })), false, outcome);
  }
  assert.equal(releasesDependents(work("blocker", { outcome: "accepted" })), true);
  assert.equal(releasesDependents(work("blocker")), false, "an unfinished blocker releases nothing");
});

test("derives every graph status and the executable frontier", () => {
  const graph = buildGraph([
    work("accepted", { outcome: "accepted" }),
    work("rolled", { outcome: "rolled-back" }),
    work("superseded", { outcome: "superseded" }),
    work("cancelled", { outcome: "cancelled" }),
    work("running", { active: true }),
    work("free"),
    work("released", { blockedBy: ["accepted"] }),
    work("waiting", { blockedBy: ["rolled"] }),
  ]);
  const status = new Map(graph.nodes.map((node) => [node.id, node.status]));
  assert.equal(status.get(id("accepted")), "accepted");
  assert.equal(status.get(id("rolled")), "rolled-back");
  assert.equal(status.get(id("superseded")), "superseded");
  assert.equal(status.get(id("cancelled")), "cancelled");
  assert.equal(status.get(id("running")), "active");
  assert.equal(status.get(id("free")), "executable");
  assert.equal(status.get(id("released")), "executable", "an accepted blocker releases its dependent");
  assert.equal(status.get(id("waiting")), "blocked", "a rolled-back blocker does not");
  assert.deepEqual(graph.executable.sort(), [id("free"), id("released")].sort());
});

test("reports reverse edges so a blocker names what it holds up", () => {
  const graph = buildGraph([work("base"), work("left", { blockedBy: ["base"] }), work("right", { blockedBy: ["base"] })]);
  const base = graph.nodes.find((node) => node.id === id("base"));
  assert.deepEqual(base?.blocks, [id("left"), id("right")]);
  assert.deepEqual(base?.blockedBy, []);
});

test("a blocker missing from the repository is unresolved rather than ignored", () => {
  const graph = buildGraph([work("dependent", { blockedBy: ["absent"] })]);
  const node = graph.nodes[0];
  assert.equal(node?.status, "blocked");
  assert.deepEqual(node?.unresolvedBlockers, [id("absent")]);
});

test("Build refuses every unresolved blocker and names its state", () => {
  const dependent = work("dependent", { blockedBy: ["blocker"] });
  for (const outcome of ["rolled-back", "superseded", "cancelled"] as const) {
    assert.throws(
      () => assertBuildUnblocked(dependent, new Map([[id("blocker"), work("blocker", { outcome })]])),
      (error: unknown) => error instanceof CodepatrolError && error.code === "WORK_BLOCKED" && error.message.includes(outcome),
      outcome,
    );
  }
  assert.throws(
    () => assertBuildUnblocked(dependent, new Map()),
    (error: unknown) => error instanceof CodepatrolError && error.code === "WORK_BLOCKED" && error.message.includes("not found locally"),
  );
  assert.doesNotThrow(() => assertBuildUnblocked(dependent, new Map([[id("blocker"), work("blocker", { outcome: "accepted" })]])));
});
