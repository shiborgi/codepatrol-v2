import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { COMMANDS, type CommandContext, type CommandSpec } from "../cli/registry.js";
import { CodepatrolError } from "../core/errors.js";

function command(name: CommandSpec["name"]): CommandSpec {
  const found = COMMANDS.find((item) => item.name === name);
  assert.ok(found);
  return found;
}

function context(workspace: string, works: Record<string, unknown>, spec: Record<string, unknown> = {}): CommandContext {
  return {
    workspace,
    works: works as unknown as CommandContext["works"],
    spec: spec as unknown as CommandContext["spec"],
    initiatives: { list: async () => [], show: async () => { throw new Error("unused stub"); } },
    publication: { automatic: async () => undefined },
    initialization: { run: async () => ({ status: "unchanged", baseBranch: "main", files: [], nextCommand: "codepatrol doctor" }) },
    doctor: { run: async () => ({ status: "ready", checks: [] }) },
  };
}

function invalidInput(error: unknown): boolean {
  return error instanceof CodepatrolError && error.code === "INVALID_INPUT";
}

async function jsonFile(workspace: string, value: unknown): Promise<string> {
  const file = `${workspace}.json`;
  await writeFile(file, JSON.stringify(value), "utf8");
  return file;
}

test("todo parsing rejects unknown fields and duplicate ids", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "codepatrol-cli-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  t.after(() => rm(`${workspace}.json`, { force: true }));
  const plan = command("plan");
  const fake = context(workspace, { start: async () => assert.fail("invalid todo reached the service") });

  for (const todo of [
    [{ id: "T1", title: "one", extra: true }],
    [{ id: "T1", title: "one" }, { id: "T1", title: "two" }],
  ]) {
    const file = await jsonFile(workspace, todo);
    await assert.rejects(plan.run(fake, ["start", "work-1", "--harness", "h", "--model", "m", "--todo", file]), invalidInput);
  }
});

test("result parsing is strict recursively and enforces conditional fields", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "codepatrol-cli-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  t.after(() => rm(`${workspace}.json`, { force: true }));
  const review = command("review");
  const fake = context(workspace, { complete: async () => assert.fail("invalid result reached the service") });
  const base = {
    decision: "continue",
    summary: "reviewed",
    handoff: "build it",
    todo: [{ id: "T1", status: "completed" }],
    artifacts: [],
  };
  const invalid = [
    { ...base, extra: true },
    { ...base, todo: [{ id: "T1", status: "done" }] },
    { ...base, todo: [{ id: "T1", status: "completed", extra: true }] },
    { ...base, todo: [{ id: "T1", status: "completed" }, { id: "T1", status: "failed" }] },
    { ...base, artifacts: [{ path: "report.txt", kind: "evidence", extra: true }] },
    { ...base, artifacts: [{ path: "", kind: "evidence" }] },
    { ...base, returnTo: "plan" },
    { ...base, reasons: ["not a return"] },
    { ...base, authority: "reviewer" },
    { ...base, decision: "return", returnTo: "review", reasons: ["not earlier"] },
    { ...base, decision: "return", returnTo: "plan", reasons: [] },
    { ...base, decision: "return", returnTo: "plan", reasons: [""] },
  ];

  for (const result of invalid) {
    const file = await jsonFile(workspace, result);
    await assert.rejects(review.run(fake, ["complete", "work-1", "--run", "run-1", "--result", file]), invalidInput);
  }
});

test("ship authority and trace members are strict", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "codepatrol-cli-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  t.after(() => rm(`${workspace}.json`, { force: true }));
  const fake = context(workspace, {
    complete: async () => assert.fail("invalid result reached the service"),
    trace: async () => assert.fail("invalid trace reached the service"),
  });
  const result = { decision: "accept", summary: "ship", handoff: "closed", todo: [], artifacts: [] };
  let file = await jsonFile(workspace, result);
  await assert.rejects(command("ship").run(fake, ["complete", "work-1", "--run", "run-1", "--result", file]), invalidInput);

  for (const trace of [
    { type: "action", message: "ran", extra: true },
    { type: "action", message: "ran", data: [] },
    { type: "action", message: "ran", data: null },
  ]) {
    file = await jsonFile(workspace, trace);
    await assert.rejects(command("plan").run(fake, ["trace", "work-1", "--run", "run-1", "--input", file]), invalidInput);
  }
});

test("work create is refused, and refresh and resume are forwarded", async () => {
  let refreshed: unknown;
  let resumed: unknown;
  const fake = context(".", {
    refresh: async (workId: string) => {
      refreshed = workId;
      return { workId };
    },
    resume: async (stage: string, workId: string) => {
      resumed = { stage, workId };
      return resumed;
    },
  });

  // Creating a Work outside an Initiative document is not a supported operation, and
  // the error says where to go instead rather than just rejecting the flag.
  await assert.rejects(
    command("work").run(fake, ["create", "--type", "Bug", "--title", "broken"]),
    (error: unknown) => error instanceof CodepatrolError
      && error.code === "INVALID_ARGUMENT"
      && error.message.includes("codepatrol spec apply"),
  );

  await command("change").run(fake, ["refresh", "work-2"]);
  await command("verify").run(fake, ["resume", "work-3"]);
  assert.equal(refreshed, "work-2");
  assert.deepEqual(resumed, { stage: "verify", workId: "work-3" });
});

test("spec validates an Initiative document before the service sees it", async () => {
  let validated: unknown;
  const fake = context("/tmp", {}, {
    validate: async (document: unknown) => {
      validated = document;
      return { documentId: "d" };
    },
  });

  await assert.rejects(
    command("spec").run(fake, ["conjure", "--initiative", "/tmp/nope.json"]),
    (error: unknown) => error instanceof CodepatrolError && error.code === "INVALID_ARGUMENT",
  );
  assert.equal(validated, undefined);
});

test("sync rejects an invalid Work id and surfaces publication failures", async () => {
  const sync = command("sync");
  let calls = 0;
  const fake: CommandContext = {
    ...context(".", {}),
    publication: {
      automatic: async () => {
        calls += 1;
        throw new CodepatrolError("GH_ERROR", "publication failed");
      },
    },
  };

  await assert.rejects(sync.run(fake, ["--work", "bad"]), (error: unknown) => error instanceof CodepatrolError && error.code === "INVALID_WORK_ID");
  assert.equal(calls, 0);
  await assert.rejects(
    sync.run(fake, ["--work", "INIT-0.1-example"]),
    (error: unknown) => error instanceof CodepatrolError && error.code === "GH_ERROR",
  );
  assert.equal(calls, 1);
});

test("sync --work accepts a short INIT-x.y code alongside the full id", async () => {
  // The CLI flag is the boundary where a caller types a handle, so the short
  // code must pass validation here even though the resolver is what the
  // service ultimately relies on for existence.
  const sync = command("sync");
  const seen: string[] = [];
  const fake: CommandContext = {
    ...context(".", {}),
    publication: {
      automatic: async (input) => {
        seen.push(input.workId ?? "");
        throw new CodepatrolError("GH_ERROR", "publication failed");
      },
    },
  };

  await assert.rejects(sync.run(fake, ["--work", "INIT-0.1"]), (error: unknown) => error instanceof CodepatrolError && error.code === "GH_ERROR");
  assert.deepEqual(seen, ["INIT-0.1"], "the short code passes CLI validation and is forwarded to the service unchanged");
});

test("public JSON examples pass the real CLI decoders", async () => {
  const controls = await mkdtemp(path.join(os.tmpdir(), "codepatrol-examples-"));
  const example = async (name: string): Promise<string> => {
    const target = path.join(controls, name);
    await writeFile(target, await readFile(path.join(process.cwd(), "examples", name), "utf8"), "utf8");
    return target;
  };
  const fake = context(process.cwd(), {
    start: async () => ({ workId: "work-1" }),
    trace: async () => ({ type: "command" }),
    complete: async () => ({ workId: "work-1" }),
  });
  try {
    await command("plan").run(fake, ["start", "work-1", "--harness", "test", "--model", "test", "--todo", await example("todo.json")]);
    await command("plan").run(fake, ["trace", "work-1", "--run", "run-1", "--input", await example("trace.json")]);
    await command("plan").run(fake, ["complete", "work-1", "--run", "run-1", "--result", await example("result-continue.json")]);
    await command("verify").run(fake, ["complete", "work-1", "--run", "run-1", "--result", await example("result-return.json")]);
    await command("ship").run(fake, ["complete", "work-1", "--run", "run-1", "--result", await example("result-ship.json")]);
  } finally {
    await rm(controls, { recursive: true, force: true });
  }
});
