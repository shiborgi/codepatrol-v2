import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { COMMANDS, helpText } from "../cli/registry.js";
import { parseInitiativeDocument } from "../core/initiative-document.js";
import { parseWorkManifest } from "../core/work-manifest.js";
import { parseResult } from "../cli/inputs.js";

/**
 * Documentation drift is a correctness problem here: the protocol document is
 * normative, and an executor that follows a stale example produces input the
 * CLI rejects. So the examples are parsed by the real decoders rather than
 * merely proof-read.
 */
async function doc(name: string): Promise<string> {
  return readFile(path.join(process.cwd(), "docs", name), "utf8");
}

/** Every fenced JSON block, in order of appearance. */
function jsonBlocks(markdown: string): unknown[] {
  return [...markdown.matchAll(/```json\n([\s\S]*?)```/g)].map((match) => JSON.parse(match[1] as string) as unknown);
}

test("the normative manifest example parses", async () => {
  const blocks = jsonBlocks(await doc("protocol.md"));
  const manifest = blocks.find((block) => (block as { type?: unknown }).type === "codepatrol-work");
  assert.ok(manifest, "protocol.md documents a manifest");
  const parsed = parseWorkManifest(manifest);
  assert.equal(parsed.workflow.state, "ready");
  assert.equal(parsed.work.initiative.id, "INIT-0");
  assert.ok(parsed.work.acceptance.length > 0, "the example states acceptance criteria");
});

test("the normative Initiative document example parses", async () => {
  const blocks = jsonBlocks(await doc("protocol.md"));
  const document = blocks.find((block) => (block as { type?: unknown }).type === "codepatrol-initiative-document");
  assert.ok(document, "protocol.md documents an Initiative document");
  const parsed = parseInitiativeDocument(document);
  assert.ok(parsed.works.length > 0);
});

test("the published Initiative document example parses", async () => {
  const raw = await readFile(path.join(process.cwd(), "examples", "initiative.json"), "utf8");
  const parsed = parseInitiativeDocument(JSON.parse(raw) as unknown);
  assert.equal(parsed.works.length, 2);
});

test("every documented command exists, and every command is documented", async () => {
  const readme = await readFile(path.join(process.cwd(), "README.md"), "utf8");
  const help = helpText();
  for (const command of COMMANDS) {
    assert.match(help, new RegExp(`\\n  ${command.name}\\s`), `${command.name} is missing from --help`);
  }
  // The entry point and the graph must be discoverable from the README, since
  // they are the two things a reader will not guess from the stage commands.
  for (const usage of ["codepatrol spec inspect", "codepatrol spec apply", "work graph"]) {
    assert.ok(readme.includes(usage), `README does not mention ${usage}`);
  }
  assert.doesNotMatch(readme, /work create/, "work create no longer exists");
});

test("the published Ship example parses", async () => {
  const raw = JSON.parse(await readFile(path.join(process.cwd(), "examples", "result-ship.json"), "utf8")) as unknown;
  const result = parseResult(raw, "ship");
  assert.equal(result.decision, "accept");
  assert.ok(result.authority, "the example shows the authority Ship requires");
});

test("the evidence a terminal Work records is documented where a reader will look", async () => {
  const security = await readFile(path.join(process.cwd(), "SECURITY.md"), "utf8");
  // The default is the security property; the wording may change, the default
  // may not without this failing.
  assert.match(security, /By default the manifest records no command output at all/);
  assert.match(security, /Redaction is a pattern net/);
  assert.match(security, /persistOutputExcerpt/);
});

test("compatibility states the real rule rather than a migration that does not exist", async () => {
  const compatibility = await doc("compatibility.md");
  assert.match(compatibility, /There is no migration path, by design/);
  assert.doesNotMatch(compatibility, /migrates it without inventing facts/, "the promise had no implementation behind it");
});

test("the release documents its requirements and its limits", async () => {
  const installation = await doc("installation.md");
  assert.match(installation, /Node\.js \| 20 or later/);
  assert.match(installation, /Git \| 2\.38 or later/);

  const limitations = await doc("limitations.md");
  assert.match(limitations, /Windows is not verified/);

  const compatibility = await doc("compatibility.md");
  for (const contract of ["CLI surface", "Error codes", "Work manifest", "Handoff", "Initiative document"]) {
    assert.ok(compatibility.includes(contract), `compatibility.md does not cover ${contract}`);
  }
});

test("the CI matrix matches the platforms the release claims", async () => {
  const workflow = await readFile(path.join(process.cwd(), ".github", "workflows", "verify.yml"), "utf8");
  const matrix = /^\s*os: \[(.+)\]$/m.exec(workflow)?.[1]?.split(",").map((entry) => entry.trim()) ?? [];
  assert.deepEqual(matrix.sort(), ["macos-latest", "ubuntu-latest"]);

  // A platform is supported only if CI runs it. Windows is documented as
  // unverified precisely because it is absent from the matrix above.
  const installation = await doc("installation.md");
  const operatingSystems = installation.split("| Operating system |")[1]?.split("|")[0] ?? "";
  assert.match(operatingSystems, /Linux, macOS/);
  assert.doesNotMatch(operatingSystems, /Windows/, "installation.md must not list an unverified platform as supported");
  for (const node of ["20", "22"]) assert.match(workflow, new RegExp(`"${node}"`), `Node ${node} is not in CI`);
  assert.match(workflow, /npm run smoke/, "CI does not run the external smoke test");
});

test("the projection E2E asserts remote state rather than only that the base moved", async () => {
  const scenario = await readFile(path.join(process.cwd(), "scripts", "projection-e2e.mjs"), "utf8");
  // Each of these is a remote fact the unit suite proves only against a fake.
  for (const assertion of [
    "exactly one Issue exists for the Work",
    "the Issue is closed once the Work is terminal",
    "the archive ref exists remotely",
    "no longer exists remotely",
    "no duplicate Issue",
    "the Initiative projects onto exactly one Milestone",
    "the Milestone title carries the Initiative id",
    "the Work's Issue is attached to the Initiative's Milestone",
    "a repeated sync creates no duplicate Milestone",
    "no raw command output is published",
    "the Initiative ref exists remotely",
    // Project projection is part of v1.0.0, so the scenario has to prove it
    // rather than only claim it in a comment.
    "the Issue was added to the Project",
    "Project Status follows the stage",
    "Project Status reached Verify",
    "Project Status Done",
    "Project Outcome is",
    "leaves the Project fields unchanged",
    "Project Next shows the decided next step",
    "a terminal Work shows next as done",
    "leaves the Next field unchanged",
  ]) {
    assert.ok(scenario.includes(assertion), `the projection E2E does not check: ${assertion}`);
  }

  const workflow = await readFile(path.join(process.cwd(), ".github", "workflows", "projection-e2e.yml"), "utf8");
  assert.match(workflow, /scenario: \[accept, rollback\]/, "both outcomes must run");
  assert.match(workflow, /node scripts\/projection-e2e\.mjs/, "the workflow must drive the shared scenario");
  assert.match(workflow, /CODEPATROL_BIN=.*node_modules\/codepatrol/, "the scenario must run against the packaged artifact");
  // A scenario that leaves Project disabled cannot assert Project state, so the
  // claim and the setup have to agree.
  assert.match(scenario, /"--project", "managed"/, "the scenario must enable Project projection");

  // Actions pinned to a runtime the runners have deprecated fail with a warning
  // today and a hard error later; the release must not ship on one.
  for (const file of ["verify.yml", "projection-e2e.yml"]) {
    const yaml = await readFile(path.join(process.cwd(), ".github", "workflows", file), "utf8");
    assert.doesNotMatch(yaml, /actions\/(checkout|setup-node)@v[1-4]\b/, `${file} pins a deprecated action major`);
  }
});
