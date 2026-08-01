import assert from "node:assert/strict";
import test from "node:test";
import { GhGitHubProjects } from "../adapters/gh-projects.js";
import { CodepatrolError } from "../core/errors.js";
import { PROJECT_OUTCOMES, PROJECT_STATUSES } from "../core/types.js";

const repository = { nameWithOwner: "acme/widget", gitUrl: "https://github.com/acme/widget" };
const issue = { number: 7, title: "Work", body: "", state: "open" as const, author: "agent", url: "https://github.com/acme/widget/issues/7", labels: ["codepatrol:type/task"] };

function fieldsJson(statusOptions: string[], outcomeOptions: string[] = [...PROJECT_OUTCOMES]): string {
  return JSON.stringify({ fields: [
    { id: "STATUS", name: "Status", type: "ProjectV2SingleSelectField", options: statusOptions.map((name) => ({ id: name.toLowerCase().replaceAll(" ", "-"), name })) },
    { id: "OUTCOME", name: "Outcome", type: "ProjectV2SingleSelectField", options: outcomeOptions.map((name) => ({ id: name.toLowerCase().replaceAll(" ", "-"), name })) },
  ] });
}

test("creates a managed Project and reconciles Status and Outcome", async () => {
  let description = "";
  let statusOptions: string[] = ["Todo", "In Progress", "Done"];
  let itemId: string | undefined;
  const editedFields: string[] = [];
  const calls: string[][] = [];
  const run = async (args: string[]): Promise<string> => {
    calls.push(args);
    const command = `${args[0]} ${args[1]}`;
    if (command === "project list") return JSON.stringify({ projects: [] });
    if (command === "project create") {
      return JSON.stringify({ id: "PVT_1", number: 1, title: "Codepatrol: acme/widget", closed: false });
    }
    if (command === "project edit") {
      description = args[args.indexOf("--description") + 1] as string;
      return "";
    }
    if (command === "project link") return "";
    if (command === "project field-list") return fieldsJson(statusOptions);
    if (args[0] === "api" && args[1] === "graphql") {
      statusOptions = [...PROJECT_STATUSES];
      return JSON.stringify({ data: { updateProjectV2Field: { clientMutationId: null } } });
    }
    if (command === "project item-list") return JSON.stringify({ items: itemId === undefined ? [] : [{ id: itemId, content: { url: issue.url } }] });
    if (command === "project item-add") {
      itemId = "ITEM_1";
      return JSON.stringify({ id: itemId });
    }
    if (command === "project item-edit") {
      editedFields.push(args[args.indexOf("--field-id") + 1] as string);
      return "";
    }
    throw new Error(`Unexpected command: ${args.join(" ")}`);
  };

  const projects = new GhGitHubProjects(run);
  const project = await projects.ensure(repository);
  await projects.reconcile(project, issue, "Build", "None");
  const editsAfterFirst = calls.filter((args) => args[1] === "item-edit").length;
  await projects.reconcile(project, issue, "Done", "Accepted");

  assert.equal(project.title, "Codepatrol: acme/widget");
  assert.equal(description, "Managed by Codepatrol for acme/widget.");
  assert.equal(project.statusFieldId, "STATUS");
  assert.equal(project.outcomeFieldId, "OUTCOME");
  assert.deepEqual(Object.keys(project.statusOptions), PROJECT_STATUSES);
  assert.deepEqual(Object.keys(project.outcomeOptions), PROJECT_OUTCOMES);
  assert.equal(editsAfterFirst, 2, "Status and Outcome are both set");
  assert.equal(calls.filter((args) => args[1] === "item-edit").length, editsAfterFirst + 2);
  assert.ok(calls.some((args) => args[0] === "api" && args[1] === "graphql"));
  assert.ok(calls.some((args) => args[1] === "item-add"));
});

test("uses native fields as-is when their options already match", async () => {
  const calls: string[][] = [];
  const run = async (args: string[]): Promise<string> => {
    calls.push(args);
    const command = `${args[0]} ${args[1]}`;
    if (command === "project list") return JSON.stringify({ projects: [{ id: "PVT_1", number: 1, title: "Codepatrol: acme/widget", shortDescription: "Managed by Codepatrol for acme/widget.", closed: false }] });
    if (command === "project link") return "";
    if (command === "project field-list") return fieldsJson([...PROJECT_STATUSES]);
    if (command === "project item-list") return JSON.stringify({ items: [] });
    throw new Error(`Unexpected command: ${args.join(" ")}`);
  };

  const project = await new GhGitHubProjects(run).ensure(repository);

  assert.equal(project.statusFieldId, "STATUS");
  assert.equal(project.outcomeFieldId, "OUTCOME");
  assert.deepEqual(Object.keys(project.statusOptions), PROJECT_STATUSES);
  assert.deepEqual(Object.keys(project.outcomeOptions), PROJECT_OUTCOMES);
  assert.ok(!calls.some((args) => (args[0] === "api" && args[1] === "graphql") || args[1] === "field-create" || args[1] === "field-delete"));
});

test("refuses to rewrite a Status field that already has items", async () => {
  const run = async (args: string[]): Promise<string> => {
    const command = `${args[0]} ${args[1]}`;
    if (command === "project list") return JSON.stringify({ projects: [{ id: "PVT_1", number: 1, title: "Codepatrol: acme/widget", shortDescription: "Managed by Codepatrol for acme/widget.", closed: false }] });
    if (command === "project link") return "";
    if (command === "project field-list") return JSON.stringify({ fields: [
      { id: "STATUS", name: "Status", type: "ProjectV2SingleSelectField", options: ["Todo", "In Progress", "Done"].map((name) => ({ id: name.toLowerCase().replaceAll(" ", "-"), name })) },
      { id: "OUTCOME", name: "Outcome", type: "ProjectV2SingleSelectField", options: PROJECT_OUTCOMES.map((name) => ({ id: name.toLowerCase().replaceAll(" ", "-"), name })) },
    ] });
    if (command === "project item-list") return JSON.stringify({ items: [{ id: "ITEM_1", content: { url: issue.url } }] });
    throw new Error(`Unexpected command: ${args.join(" ")}`);
  };

  await assert.rejects(
    new GhGitHubProjects(run).ensure(repository),
    (error: unknown) => error instanceof CodepatrolError && error.code === "SYNC_CONFLICT",
  );
});

test("refuses a closed managed Project", async () => {
  const run = async (args: string[]): Promise<string> => {
    const command = `${args[0]} ${args[1]}`;
    if (command === "project list") return JSON.stringify({ projects: [{ id: "PVT_1", number: 1, title: "Renamed", shortDescription: "Managed by Codepatrol for acme/widget.", closed: true }] });
    throw new Error(`Unexpected command: ${args.join(" ")}`);
  };

  await assert.rejects(
    new GhGitHubProjects(run).ensure(repository),
    (error: unknown) => error instanceof CodepatrolError && error.code === "SYNC_CONFLICT",
  );
});
