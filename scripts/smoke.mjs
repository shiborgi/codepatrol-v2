#!/usr/bin/env node
/**
 * The external smoke test: a clean repository, driven only through the public
 * CLI, with no Git remote.
 *
 * It exists because the unit suite builds its repositories through the same
 * services it tests. This one shells out to `bin/codepatrol.js` exactly as a
 * user would, so a broken entry point, a bad `files` list, or a command that
 * only works from inside this repository fails here rather than after release.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const CLI = process.env.CODEPATROL_BIN ?? path.resolve(fileURLToPath(import.meta.url), "../../bin/codepatrol.js");
const root = mkdtempSync(path.join(tmpdir(), "codepatrol-smoke-"));
const controls = mkdtempSync(path.join(tmpdir(), "codepatrol-smoke-controls-"));
let failures = 0;

function check(condition, description) {
  if (condition) {
    process.stdout.write(`  ok   ${description}\n`);
    return;
  }
  failures += 1;
  process.stdout.write(`  FAIL ${description}\n`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: options.cwd ?? root, encoding: "utf8" });
  if (result.status !== 0 && options.allowFailure !== true) {
    throw new Error(`${command} ${args.join(" ")} failed:\n${result.stderr || result.stdout}`);
  }
  return result;
}

function git(...args) {
  return run("git", args).stdout.trim();
}

function codepatrol(...args) {
  const result = run(process.execPath, [CLI, "--workspace", root, ...args]);
  return result.stdout.trim() === "" ? {} : JSON.parse(result.stdout);
}

function codepatrolFails(...args) {
  const result = run(process.execPath, [CLI, "--workspace", root, ...args], { allowFailure: true });
  if (result.status === 0) throw new Error(`codepatrol ${args.join(" ")} was expected to fail`);
  return JSON.parse(result.stderr.trim());
}

function control(name, value) {
  const file = path.join(controls, name);
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return file;
}

const TODO = control("todo.json", [{ id: "T1", title: "Do the step" }]);
const DONE = [{ id: "T1", status: "completed" }];

function start(name, workId) {
  return codepatrol(name, "start", workId, "--harness", "smoke", "--model", "smoke-model", "--todo", TODO);
}

function stage(name, workId, options = {}) {
  const started = start(name, workId);
  const decision = options.decision ?? (name === "ship" ? "accept" : "continue");
  codepatrol(name, "complete", workId, "--run", started.runId, "--result", control("result.json", {
    decision,
    summary: `${name} done`,
    handoff: "next",
    todo: DONE,
    artifacts: [],
    ...(name === "ship" ? { authority: "smoke-owner" } : {}),
    ...options,
  }));
  return started;
}

function document(works, extra = {}) {
  const inspection = codepatrol("spec", "inspect");
  return control("document.json", {
    schemaVersion: 1,
    type: "codepatrol-initiative-document",
    documentId: `smoke-${Date.now()}`,
    summary: "Smoke document",
    observedState: `${inspection.graph.nodes.length} Work(s) observed`,
    digest: inspection.digest,
    createdAt: new Date().toISOString(),
    works,
    cancel: [],
    supersede: [],
    followUp: [],
    ...extra,
  });
}


const CREATE = {
  description: "Exercised by the external smoke test",
  issueType: "Task",
  priority: "p1",
  acceptance: ["The behaviour is demonstrably present"],
};

try {
  process.stdout.write(`Codepatrol smoke in ${root}\n\n`);

  run("git", ["init", "--quiet", "--initial-branch=trunk", root], { cwd: tmpdir() });
  git("config", "user.email", "smoke@local.invalid");
  git("config", "user.name", "Smoke");
  writeFileSync(path.join(root, "README.md"), "# Smoke\n", "utf8");
  git("add", "README.md");
  git("commit", "--quiet", "-m", "bootstrap");
  check(git("remote").length === 0, "the repository has no Git remote");

  process.stdout.write("Initialization and diagnostics\n");
  const initialized = codepatrol("init", "--verify-commands", JSON.stringify([["node", "-e", "process.exit(0)"]]));
  check(initialized.status === "initialized", "codepatrol init creates configuration and policy");
  check(initialized.baseBranch === "trunk", "init detects the base branch");
  const again = codepatrol("init", "--verify-commands", JSON.stringify([["node", "-e", "process.exit(0)"]]));
  check(again.status === "unchanged", "repeated init is idempotent");
  const doctor = codepatrol("doctor");
  check(doctor.status === "ready", "doctor reports the repository is ready");
  check(doctor.checks.every((c) => c.status !== "failed"), "no doctor check failed");
  git("add", ".codepatrol/config.json", ".codepatrol/policy.json");
  git("commit", "--quiet", "-m", "codepatrol init");

  process.stdout.write("\nSpec creates the Work graph\n");
  const dry = codepatrol("spec", "validate", "--initiative", document([
    { key: "first", ...CREATE, title: "Deliver the feature" },
    { key: "second", ...CREATE, title: "Follow the feature", blockedBy: ["#first"] },
  ], { initiative: { title: "Smoke initiative", intent: "i", motivation: "m", ordering: "o" } }));
  check(dry.nextCommand === "codepatrol spec apply --initiative <the same file>", "a dry run reports without writing");
  check(codepatrol("work", "list").length === 0, "the dry run created nothing");

  const applied = codepatrol("spec", "apply", "--initiative", document([
    { key: "first", ...CREATE, title: "Deliver the feature" },
    { key: "second", ...CREATE, title: "Follow the feature", blockedBy: ["#first"] },
  ], { initiative: { title: "Smoke initiative", intent: "i", motivation: "m", ordering: "o" } }));
  const [first, second] = applied.createdWorkIds;
  check(applied.createdWorkIds.length === 2, "applying created two Works");
  check(applied.publication.state === "skipped", "publication is skipped without a remote");

  const graph = codepatrol("work", "graph");
  check(graph.executable.length === 1 && graph.executable[0] === first, "only the unblocked Work is executable");

  const inspection = codepatrol("spec", "inspect");
  check(inspection.order.waves.length === 2, "the attack order has two waves");
  check(inspection.order.waves[0].works.includes(first), "wave 1 holds the unblocked Work");
  check(inspection.order.waves[1].works.includes(second), "wave 2 holds the dependent");
  check(inspection.order.blocked.some((entry) => entry.workId === second && entry.blockers[0].id === first), "the blocked Work names its blocker and its wave");
  const initiative = codepatrol("initiative", "show", applied.initiative);
  check(initiative.works.length === 2, "initiative show derives its Works from their identifiers");
  check(initiative.order.criticalPath.length === 2, "the Initiative reports its critical path");

  process.stdout.write("\nThe blocked Work refuses to Build\n");
  stage("plan", second);
  stage("review", second);
  const blocked = codepatrolFails("build", "start", second, "--harness", "smoke", "--model", "m", "--todo", TODO);
  check(blocked.error === "WORK_BLOCKED", "Build is refused while a blocker is unaccepted");
  check(typeof blocked.recovery?.nextCommand === "string", "the refusal names a safe next command");

  process.stdout.write("\nThe first Work is accepted\n");
  stage("plan", first);
  stage("review", first);
  const built = start("build", first);
  check(
    run("git", ["cat-file", "-e", `refs/heads/trunk:.codepatrol/works/${first}/work.json`], { allowFailure: true }).status === 0,
    "opening the branch projects the manifest into the base",
  );
  writeFileSync(path.join(built.worktreeDirectory, "feature.txt"), "delivered\n", "utf8");
  run("git", ["add", "feature.txt"], { cwd: built.worktreeDirectory });
  run("git", ["commit", "--quiet", "-m", "implement the feature"], { cwd: built.worktreeDirectory });
  codepatrol("build", "complete", first, "--run", built.runId, "--result", control("result.json", {
    decision: "continue", summary: "built", handoff: "verify", todo: DONE, artifacts: [{ path: "feature.txt", kind: "source" }],
  }));
  stage("verify", first);
  const baseBefore = git("rev-parse", "refs/heads/trunk");
  stage("ship", first);

  const accepted = codepatrol("work", "show", first);
  check(accepted.outcome === "accepted", "the first Work is accepted");
  const commitsAdded = Number(git("rev-list", "--count", `${baseBefore}..refs/heads/trunk`));
  check(commitsAdded === 1, `accept added exactly one squash commit (added ${commitsAdded})`);
  check(git("show", "refs/heads/trunk:feature.txt").trim() === "delivered", "the product change reached the base");
  check(git("rev-parse", "--verify", "--quiet", `refs/heads/codepatrol/archive/${first}`) !== "", "the archive preserves the Change");
  check(
    run("git", ["rev-parse", "--verify", "--quiet", `refs/heads/codepatrol/work/${first}`], { allowFailure: true }).status !== 0,
    "the open Change branch is gone",
  );

  process.stdout.write("\nThe second Work is released and rolled back\n");
  const released = codepatrol("work", "show", second);
  check(released.graph.status === "executable", "an accepted blocker releases its dependent");
  const rebuilt = start("build", second);
  writeFileSync(path.join(rebuilt.worktreeDirectory, "follow.txt"), "wrong turn\n", "utf8");
  run("git", ["add", "follow.txt"], { cwd: rebuilt.worktreeDirectory });
  run("git", ["commit", "--quiet", "-m", "implement the follow-up"], { cwd: rebuilt.worktreeDirectory });
  codepatrol("build", "complete", second, "--run", rebuilt.runId, "--result", control("result.json", {
    decision: "continue", summary: "built", handoff: "verify", todo: DONE, artifacts: [],
  }));
  stage("verify", second);
  const baseBeforeRollback = git("rev-parse", "refs/heads/trunk");
  stage("ship", second, { decision: "rollback", summary: "the approach was wrong", handoff: "terminal" });

  const rolled = codepatrol("work", "show", second);
  check(rolled.outcome === "rolled-back", "the second Work is rolled back");
  check(git("rev-parse", "refs/heads/trunk") === baseBeforeRollback, "rollback added no commit to the base");
  check(
    run("git", ["cat-file", "-e", "refs/heads/trunk:follow.txt"], { allowFailure: true }).status !== 0,
    "the rolled-back product change never reached the base",
  );
  check(git("rev-parse", "--verify", "--quiet", `refs/heads/codepatrol/archive/${second}`) !== "", "a rolled-back Work survives in its archive");

  process.stdout.write("\nSpec ends a Work without shipping it\n");
  const extra = codepatrol("spec", "apply", "--initiative", document([
    { key: "doomed", ...CREATE, title: "Abandoned direction" },
  ]));
  const doomed = extra.createdWorkIds[0];
  const baseBeforeCancel = git("rev-parse", "refs/heads/trunk");
  codepatrol("spec", "apply", "--initiative", document([], {
    cancel: [{ workId: doomed, reason: "the premise no longer holds", authority: "smoke-owner" }],
  }));
  const cancelled = codepatrol("work", "show", doomed);
  check(cancelled.outcome === "cancelled", "a cancelled Work is neither accepted nor rolled back");
  check(git("rev-parse", "refs/heads/trunk") === baseBeforeCancel, "cancelling added no commit to the base");

  process.stdout.write("\nFinished Works keep their evidence\n");
  const firstShown = codepatrol("work", "show", first);
  check(firstShown.outcome === "accepted", "an accepted Work keeps its outcome");
  check(firstShown.attempts.some((attempt) => attempt.stage === "verify" && attempt.verifiedCandidate !== undefined), "the verified candidate is recorded as evidence");

  process.stdout.write("\nWorks are not creatable by hand\n");
  const refused = codepatrolFails("work", "create", "--type", "Task", "--title", "by hand");
  check(refused.error === "INVALID_ARGUMENT" && refused.message.includes("spec apply"), "work create redirects to Spec");

  process.stdout.write(`\n${failures === 0 ? "smoke passed" : `smoke FAILED with ${failures} problem(s)`}\n`);
  process.exitCode = failures === 0 ? 0 : 1;
} catch (error) {
  process.stderr.write(`\nsmoke aborted: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  rmSync(root, { recursive: true, force: true });
  rmSync(controls, { recursive: true, force: true });
}
