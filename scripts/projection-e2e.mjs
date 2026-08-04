#!/usr/bin/env node
/**
 * The projection end-to-end scenario, against a real GitHub repository.
 *
 * The unit suite proves the projection logic against a fake; only this proves
 * that `gh` and GitHub actually behave the way the fake claims. It runs one
 * Work all the way to a terminal outcome and then asserts what exists remotely —
 * the Issue, the Project fields, the archive ref, the deleted branch — rather
 * than only that the base moved.
 *
 * Usage: node scripts/projection-e2e.mjs <accept|rollback>
 *   CODEPATROL_BIN   the CLI to drive (defaults to this repository's)
 *   E2E_REPOSITORY   owner/name of the scratch repository
 *   GH_TOKEN         a token with contents, issues, and `project`
 *                    scope. Project projection is part of v1.0.0, so a token
 *                    without `project` fails the scenario rather than silently
 *                    skipping the assertions that justify the claim.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const outcome = process.argv[2];
if (outcome !== "accept" && outcome !== "rollback") {
  process.stderr.write("usage: projection-e2e.mjs <accept|rollback>\n");
  process.exit(2);
}

const repository = process.env.E2E_REPOSITORY;
const token = process.env.GH_TOKEN;
if (repository === undefined || repository === "" || token === undefined || token === "") {
  process.stderr.write("E2E_REPOSITORY and GH_TOKEN are required\n");
  process.exit(2);
}

const CLI = process.env.CODEPATROL_BIN ?? path.resolve(fileURLToPath(import.meta.url), "../../bin/codepatrol.js");
const workspace = mkdtempSync(path.join(tmpdir(), `codepatrol-e2e-${outcome}-`));
const controls = mkdtempSync(path.join(tmpdir(), "codepatrol-e2e-controls-"));
const stamp = Date.now();
let failures = 0;

function check(condition, description) {
  process.stdout.write(`  ${condition ? "ok  " : "FAIL"} ${description}\n`);
  if (!condition) failures += 1;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: options.cwd ?? workspace, encoding: "utf8", env: { ...process.env, ...options.env } });
  if (result.status !== 0 && options.allowFailure !== true) {
    throw new Error(`${command} ${args.join(" ")} failed:\n${result.stderr || result.stdout}`);
  }
  return result;
}

const git = (...args) => run("git", args).stdout.trim();
const gh = (...args) => JSON.parse(run("gh", args).stdout || "null");

function codepatrol(...args) {
  const out = run(process.execPath, [CLI, "--workspace", workspace, ...args]).stdout.trim();
  return out === "" ? {} : JSON.parse(out);
}

function control(name, value) {
  const file = path.join(controls, name);
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return file;
}

const TODO = control("todo.json", [{ id: "T1", title: "E2E step" }]);
const DONE = [{ id: "T1", status: "completed" }];

function stage(name, extra = {}) {
  const started = codepatrol(name, "start", workId, "--harness", "e2e", "--model", "e2e", "--todo", TODO);
  codepatrol(name, "complete", workId, "--run", started.runId, "--result", control("result.json", {
    decision: name === "ship" ? outcome : "continue",
    summary: `${name} done`,
    handoff: "next",
    todo: DONE,
    artifacts: [],
    ...extra,
  }));
  codepatrol("sync", "--work", workId);
  return started;
}

/** The Project item tracking this Work's Issue, with its single-select fields. */
function projectItem(projectNumber, issueNumber) {
  const owner = repository.split("/")[0];
  const listed = gh("project", "item-list", String(projectNumber), "--owner", owner, "--limit", "1000", "--format", "json");
  const items = listed?.items ?? [];
  return items.find((item) => item.content?.number === issueNumber);
}

function issues() {
  const all = gh("issue", "list", "--repo", repository, "--state", "all", "--limit", "100", "--json", "number,title,state,body");
  return (all ?? []).filter((issue) => issue.body?.includes(`codepatrol-work-id: ${workId}`));
}

function milestoneFor(title) {
  const all = gh("api", `repos/${repository}/milestones?state=all&per_page=100`);
  return (all ?? []).find((milestone) => milestone.title === title);
}

let workId = "";

try {
  process.stdout.write(`Projection E2E (${outcome}) against ${repository}\n\n`);

  run("git", ["clone", `https://x-access-token:${token}@github.com/${repository}.git`, workspace], { cwd: tmpdir() });
  git("config", "user.email", "e2e@codepatrol.local");
  git("config", "user.name", "Codepatrol E2E");

  // The repository is reused across runs; initialize only if it is not set up.
  // Project projection is enabled deliberately: the scenario exists to prove
  // the projections the unit suite can only prove against a fake, and Project
  // is one of them.
  const initialized = codepatrol("init", "--verify-commands", JSON.stringify([["node", "-e", "process.exit(0)"]]), "--github", "--project", "managed");
  if (initialized.status !== "unchanged") {
    git("add", ".codepatrol/");
    git("commit", "-m", "codepatrol init");
    git("push", "origin", "HEAD");
  }
  codepatrol("doctor");

  const inspection = codepatrol("spec", "inspect");
  const applied = codepatrol("spec", "apply", "--initiative", control("document.json", {
    schemaVersion: 1,
    type: "codepatrol-initiative-document",
    documentId: `e2e-${outcome}-${stamp}`,
    summary: `E2E ${outcome} scenario`,
    observedState: "e2e",
    digest: inspection.digest,
    createdAt: new Date().toISOString(),
    initiative: {
      title: `E2E ${outcome} ${stamp}`,
      intent: "Exercise the projection against a real remote",
      motivation: "One Work is enough to prove the projection",
      ordering: "Single Work, no dependencies",
    },
    works: [{
      key: "e2e",
      title: `E2E ${outcome} Work ${stamp}`,
      description: `Projection E2E ${outcome} scenario`,
      issueType: "Task",
      priority: "p1",
      acceptance: [`The E2E ${outcome} scenario passes`],
    }],
    cancel: [],
    supersede: [],
    followUp: [],
  }));
  workId = applied.createdWorkIds[0];
  codepatrol("sync", "--work", workId);

  process.stdout.write("Issue projection\n");
  const remoteIssue = issues();
  check(remoteIssue.length === 1, "exactly one Issue exists for the Work");
  const issueNumber = remoteIssue[0]?.number;

  const synced = codepatrol("sync", "--work", workId);
  const projectNumber = synced.project?.number ?? synced.result?.project?.number;
  check(typeof projectNumber === "number" && projectNumber > 0, "Project projection is configured and reported a Project");

  process.stdout.write("\nMilestone projection\n");
  const initiativeTitle = codepatrol("initiative", "show", applied.initiative).initiative.title;
  const milestone = milestoneFor(initiativeTitle);
  check(milestone !== undefined, "the Initiative projects onto exactly one Milestone");
  check((milestone?.description ?? "").includes("codepatrol:initiative:start"), "the Milestone carries the managed section");
  const issueMilestone = gh("api", `repos/${repository}/issues/${issueNumber}`)?.milestone;
  check(issueMilestone?.number === milestone?.number, "the Work's Issue is attached to the Initiative's Milestone");

  process.stdout.write("\nProject projection\n");
  stage("plan");
  let item = projectItem(projectNumber, issueNumber);
  check(item !== undefined, "the Issue was added to the Project");
  check(item?.status === "Plan", `Project Status follows the stage (saw ${item?.status})`);
  check(item?.next === "review", `Project Next shows the decided next step (saw ${item?.next}, expected review)`);

  // Build carries the product change the Change is meant to deliver.
  const built = codepatrol("build", "start", workId, "--harness", "e2e", "--model", "e2e", "--todo", TODO);
  writeFileSync(path.join(built.worktreeDirectory, `e2e-${stamp}.txt`), `${outcome}\n`, "utf8");
  run("git", ["add", "."], { cwd: built.worktreeDirectory });
  run("git", ["commit", "-m", "e2e product change"], { cwd: built.worktreeDirectory });
  codepatrol("build", "complete", workId, "--run", built.runId, "--result", control("result.json", {
    decision: "continue", summary: "built", handoff: "verify", todo: DONE, artifacts: [],
  }));
  codepatrol("sync", "--work", workId);

  stage("verify");
  item = projectItem(projectNumber, issueNumber);
  check(item?.status === "Verify", `Project Status reached Verify (saw ${item?.status})`);

  const baseBefore = git("rev-parse", "origin/main");
  stage("ship", {
    authority: "e2e",
    summary: `${outcome} by the E2E scenario`,
    handoff: "terminal",
  });

  process.stdout.write("\nTerminal state\n");
  const commitsAdded = Number(git("rev-list", "--count", `${baseBefore}..origin/main`));
  check(commitsAdded === (outcome === "accept" ? 1 : 0), `${outcome} added ${outcome === "accept" ? "one" : "no"} base commit (added ${commitsAdded})`);

  const remoteIssues = issues();
  check(remoteIssues.length === 1, "still exactly one Issue");
  check(remoteIssues[0]?.state === "CLOSED", "the Issue is closed once the Work is terminal");

  item = projectItem(projectNumber, issueNumber);
  check(item?.status === "Done", `a terminal Work reaches Project Status Done (saw ${item?.status})`);
  check(item?.next === "done", `a terminal Work shows next as done (saw ${item?.next})`);
  const expectedOutcome = outcome === "accept" ? "Accepted" : "Rolled back";
  check(item?.outcome === expectedOutcome, `Project Outcome is ${expectedOutcome} (saw ${item?.outcome})`);

  process.stdout.write("\nShip comment projection\n");
  const commented = gh("issue", "view", String(issueNumber), "--repo", repository, "--json", "comments");
  const commentBodies = (commented?.comments ?? []).map((comment) => comment.body ?? "").join("\n");
  check(commentBodies.includes(`${outcome} by the E2E scenario`), "the terminal Issue comment carries the Ship summary");
  // Command output is never safe to publish; the summary must be a summary.
  check(!commentBodies.includes("stdout") && !commentBodies.includes("stderr"), "no raw command output is published");

  const archive = git("ls-remote", "origin", `refs/heads/codepatrol/archive/${workId}`);
  check(archive !== "", "the archive ref exists remotely");
  const openBranch = git("ls-remote", "origin", `refs/heads/codepatrol/work/${workId}`);
  check(openBranch === "", "the open Work branch no longer exists remotely");
  const initiativeRef = git("ls-remote", "origin", `refs/codepatrol/initiative/${applied.initiative}-*`);
  check(initiativeRef !== "", "the Initiative ref exists remotely");

  const archived = run("git", ["show", `origin/main:.codepatrol/works/${workId}/work.json`], { allowFailure: true });
  if (outcome === "accept") {
    check(!archived.stdout.includes("\"stdout\":\"") || archived.stdout.includes("excerpt"), "command evidence is stored as a bounded excerpt, not raw output");
  }

  process.stdout.write("\nRepeated sync\n");
  const beforeRepeat = { issues: issues().length };
  codepatrol("sync", "--work", workId);
  check(issues().length === beforeRepeat.issues, "a repeated sync creates no duplicate Issue");
  const milestonesAfter = gh("api", `repos/${repository}/milestones?state=all&per_page=100`).filter((m) => m.title === initiativeTitle);
  check(milestonesAfter.length === 1, "a repeated sync creates no duplicate Milestone");
  const repeated = projectItem(projectNumber, issueNumber);
  check(repeated?.status === "Done" && repeated?.outcome === expectedOutcome, "a repeated sync leaves the Project fields unchanged");
  check(repeated?.next === "done", "a repeated sync leaves the Next field unchanged");

  process.stdout.write(`\n${failures === 0 ? `${outcome} scenario passed` : `${outcome} scenario FAILED with ${failures} problem(s)`}\n`);
  process.exitCode = failures === 0 ? 0 : 1;
} catch (error) {
  process.stderr.write(`\n${outcome} scenario aborted: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  rmSync(workspace, { recursive: true, force: true });
  rmSync(controls, { recursive: true, force: true });
}
