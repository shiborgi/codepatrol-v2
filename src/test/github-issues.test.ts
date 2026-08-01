import assert from "node:assert/strict";
import test from "node:test";
import { GhGitHubIssues, GhGitHubLabels } from "../adapters/gh-github.js";
import { CodepatrolError } from "../core/errors.js";
import { DEFAULT_WORK_TYPE_LABELS } from "../core/work-type-labels.js";

const REST_ISSUE = {
  number: 7,
  title: "Typed issue",
  body: "body",
  state: "open",
  user: { login: "owner" },
  author_association: "OWNER",
  html_url: "https://github.com/owner/repo/issues/7",
  labels: [{ name: "codepatrol:type/bug" }, { name: "security" }],
};

test("creates and edits issues through managed labels only", async () => {
  const calls: string[][] = [];
  const subject = new GhGitHubIssues(async (args) => {
    calls.push(args);
    if (args[0] === "issue" && args[1] === "create") return REST_ISSUE.html_url;
    if (args[0] === "issue" && args[1] === "edit") return "";
    if (args[0] === "api") return JSON.stringify(REST_ISSUE);
    throw new Error(`Unexpected gh call: ${args.join(" ")}`);
  });

  const created = await subject.create("owner/repo", { title: "Typed issue", body: "body", labels: ["codepatrol:type/bug"] });
  assert.deepEqual(created.labels, ["codepatrol:type/bug", "security"]);
  await subject.edit("owner/repo", created, { addLabels: ["codepatrol:type/feature"], removeLabels: ["codepatrol:type/bug"] });

  assert.ok(calls.some((args) => args.includes("create") && args.includes("--label") && args.includes("codepatrol:type/bug")));
  assert.ok(calls.some((args) => args.includes("edit") && args.includes("--add-label") && args.includes("codepatrol:type/feature") && args.includes("--remove-label") && args.includes("codepatrol:type/bug")));
  assert.ok(calls.every((args) => !args.includes("--type")), "no native Issue Type usage remains");
  assert.ok(calls.every((args) => !(args[0] === "issue" && args[1] === "view")), "no typed view query remains");
});

test("reads labels from REST listings without a typed query", async () => {
  const calls: string[][] = [];
  const subject = new GhGitHubIssues(async (args) => {
    calls.push(args);
    if (args[0] === "api") return JSON.stringify([[REST_ISSUE]]);
    throw new Error(`Unexpected gh call: ${args.join(" ")}`);
  });
  const issues = await subject.list("owner/repo");
  assert.deepEqual(issues[0]?.labels, ["codepatrol:type/bug", "security"]);
  assert.equal(issues[0]?.authorAssociation, "OWNER");
  assert.ok(calls.every((args) => !(args[0] === "issue" && args[1] === "list")));
});

test("ensures labels idempotently at the gh boundary", async () => {
  const calls: string[][] = [];
  const outcomes: string[] = [];
  let mode: "ok" | "exists" | "forbidden" | "unauthenticated" = "ok";
  const subject = new GhGitHubLabels(async (args) => {
    calls.push(args);
    if (mode === "exists") throw new CodepatrolError("GH_ERROR", "gh label create failed: HTTP 422: Validation Failed (Label already exists)");
    if (mode === "forbidden") throw new CodepatrolError("GH_ERROR", "gh label create failed: HTTP 403: Forbidden");
    if (mode === "unauthenticated") throw new CodepatrolError("GH_ERROR", "gh label create failed: HTTP 401: Bad credentials");
    return "";
  });
  const label = DEFAULT_WORK_TYPE_LABELS.Bug;

  outcomes.push((await subject.ensure("owner/repo", label)).status);
  mode = "exists";
  outcomes.push((await subject.ensure("owner/repo", label)).status);
  mode = "forbidden";
  const unavailable = await subject.ensure("owner/repo", label);
  outcomes.push(unavailable.status);
  assert.ok(unavailable.warning);
  mode = "unauthenticated";
  await assert.rejects(subject.ensure("owner/repo", label), (error: unknown) => error instanceof CodepatrolError && error.code === "GH_ERROR");

  assert.deepEqual(outcomes, ["created", "existing", "unavailable"]);
  assert.ok(calls.every((args) => args[0] === "label" && args[1] === "create"));
});

test("lists repository labels through the gh boundary", async () => {
  const subject = new GhGitHubLabels(async (args) => {
    if (args[0] === "label" && args[1] === "list") return JSON.stringify([{ name: "codepatrol:type/bug", description: "CodePatrol Work type: Bug", color: "d73a4a" }, { name: "", description: "ignored", color: "000000" }]);
    throw new Error(`Unexpected gh call: ${args.join(" ")}`);
  });
  const labels = await subject.list("owner/repo");
  assert.deepEqual(labels, [{ name: "codepatrol:type/bug", description: "CodePatrol Work type: Bug", color: "d73a4a" }]);
});
