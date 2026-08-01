import assert from "node:assert/strict";
import test from "node:test";
import { attackOrder } from "../core/waves.js";
import { manifestFixture } from "./support/fixtures.js";

test("derives waves so every Work's blockers are accepted or earlier", () => {
  const manifests = [
    manifestFixture("a"),
    manifestFixture("b", { blockedBy: ["a"] }),
    manifestFixture("c", { blockedBy: ["b"] }),
    manifestFixture("d"),
  ];
  const order = attackOrder(manifests);
  assert.deepEqual(order.waves, [
    { wave: 1, works: ["INIT-0.1-a", "INIT-0.1-d"] },
    { wave: 2, works: ["INIT-0.1-b"] },
    { wave: 3, works: ["INIT-0.1-c"] },
  ]);
  assert.deepEqual(order.criticalPath, ["INIT-0.1-a", "INIT-0.1-b", "INIT-0.1-c"]);
  assert.deepEqual(order.blocked, [
    { workId: "INIT-0.1-b", blockers: [{ id: "INIT-0.1-a", wave: 1 }] },
    { workId: "INIT-0.1-c", blockers: [{ id: "INIT-0.1-b", wave: 2 }] },
  ]);
});

test("an accepted blocker is satisfied history and joins no wave", () => {
  const manifests = [
    manifestFixture("done", { outcome: "accepted" }),
    manifestFixture("next", { blockedBy: ["done"] }),
  ];
  const order = attackOrder(manifests);
  assert.deepEqual(order.waves, [{ wave: 1, works: ["INIT-0.1-next"] }]);
  assert.deepEqual(order.blocked, []);
});

test("a blocker that never released keeps its dependent out of every wave", () => {
  for (const outcome of ["rolled-back", "superseded", "cancelled"] as const) {
    const manifests = [
      manifestFixture("gone", { outcome }),
      manifestFixture("waiting", { blockedBy: ["gone"] }),
    ];
    const order = attackOrder(manifests);
    assert.deepEqual(order.waves, [], `no wave for a dependent of a ${outcome} blocker`);
    assert.deepEqual(order.blocked, [
      { workId: "INIT-0.1-waiting", blockers: [{ id: "INIT-0.1-gone", wave: null }] },
    ]);
  }
});

test("terminal Works are invisible except as accepted blockers", () => {
  const manifests = [
    manifestFixture("done", { outcome: "accepted" }),
    manifestFixture("open"),
  ];
  const order = attackOrder(manifests);
  assert.deepEqual(order.waves.flatMap((wave) => wave.works), ["INIT-0.1-open"]);
  assert.deepEqual(order.criticalPath, ["INIT-0.1-open"]);
});

test("a diamond shares a blocker without lengthening the critical path", () => {
  const manifests = [
    manifestFixture("root"),
    manifestFixture("left", { blockedBy: ["root"] }),
    manifestFixture("right", { blockedBy: ["root"] }),
    manifestFixture("join", { blockedBy: ["left", "right"] }),
  ];
  const order = attackOrder(manifests);
  assert.deepEqual(order.waves, [
    { wave: 1, works: ["INIT-0.1-root"] },
    { wave: 2, works: ["INIT-0.1-left", "INIT-0.1-right"] },
    { wave: 3, works: ["INIT-0.1-join"] },
  ]);
  assert.equal(order.criticalPath.length, 3, "the diamond's longest chain has three Works");
  assert.equal(order.criticalPath[0], "INIT-0.1-root");
  assert.equal(order.criticalPath[2], "INIT-0.1-join");
});

test("an empty graph has no order", () => {
  const order = attackOrder([]);
  assert.deepEqual(order.waves, []);
  assert.deepEqual(order.criticalPath, []);
  assert.deepEqual(order.blocked, []);
});
