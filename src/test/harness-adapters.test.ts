import assert from "node:assert/strict";
import { readFile, readdir, readlink } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { helpText } from "../cli/registry.js";

const skillNames = ["spec", "work", "plan", "review", "build", "verify", "ship"] as const;
/** Skills that drive a lifecycle stage, and so share one command shape. */
const stageSkills = ["plan", "review", "build", "verify", "ship"] as const;
const commandNames = skillNames;
const adapters = [
  { directory: ".opencode/commands", harness: "opencode" },
  { directory: ".claude/commands", harness: "claude" },
] as const;

test("ships harness-neutral lifecycle skills", async () => {
  const directory = path.join(process.cwd(), "skills");

  for (const name of skillNames) {
    const contents = await readFile(path.join(directory, `codepatrol-${name}`, "SKILL.md"), "utf8");
    assert.match(contents, new RegExp(`^---\\nname: codepatrol-${name}\\ndescription: .+\\n---\\n`));
    assert.match(contents, /Use `codepatrol`/);
    assert.doesNotMatch(contents, /OpenCode|Claude|\bPi\b/i);
    if ((stageSkills as readonly string[]).includes(name)) {
      assert.match(contents, new RegExp(`${name}\\s+start`));
      assert.match(contents, new RegExp(`${name}\\s+resume`));
      assert.match(contents, new RegExp(`${name}\\s+trace`));
      assert.match(contents, new RegExp(`${name}\\s+complete`));
      assert.match(contents, /truthful harness and model supplied by the adapter/);
      assert.match(contents, /publication/i);
      // Publication is a projection, so a failure is retried explicitly and
      // never by repeating the lifecycle step.
      assert.match(contents, /codepatrol --workspace <main-repository-root> sync --work <work-id>/);
      assert.match(contents, /(do not|never) (restart|complete|repeat completion)|without restarting|rather than repeating completion/i);
    }
  }
  const help = helpText();
  for (const name of stageSkills) {
    for (const action of ["start", "resume", "trace", "complete"]) assert.match(help, new RegExp(`codepatrol ${name} ${action}`));
  }
});

test("keeps follow-up analysis evidence-driven", async () => {
  const contents = await readFile(path.join(process.cwd(), "skills", "codepatrol-work", "SKILL.md"), "utf8");
  assert.match(contents, /cite concrete results, returns, evidence, or terminal outcomes/i);
  assert.match(contents, /(never|do not) call GitHub directly/i);
  // Work is read-only: creating or restructuring belongs to Spec alone.
  assert.match(contents, /never creates or restructures a Work/i);
  assert.doesNotMatch(contents, /work create/);
});

test("makes Spec the only door, and a proposing one", async () => {
  const contents = await readFile(path.join(process.cwd(), "skills", "codepatrol-spec", "SKILL.md"), "utf8");
  // The skill proposes; the Core validates and applies. It must say so, and it
  // must never claim the ability to write canonical state itself.
  assert.match(contents, /You propose; the Core validates and applies/);
  assert.match(contents, /never write `work\.json`/);
  assert.match(contents, /explicit user approval before `apply`/i);
  assert.match(contents, /mutates nothing/);
  assert.match(contents, /rejects the document as stale/);
  for (const action of ["inspect", "validate", "apply"]) assert.match(contents, new RegExp(`spec ${action}`));
  // Only accept releases a dependent; the skill must not imply otherwise.
  assert.match(contents, /Only an \*\*accepted\*\* blocker releases its dependents/);
});

test("states that the lifecycle runs without a remote", async () => {
  // Local-first is a promise the skills must make, not just an implementation
  // detail: an executor that believes GitHub is required will stall without it.
  const contents = await readFile(path.join(process.cwd(), "skills", "codepatrol-work", "SKILL.md"), "utf8");
  assert.match(contents, /runs with no Git remote configured/);
  assert.match(contents, /projection that never governs (the lifecycle|local state)/);
});

test("describes local integration rather than a remote merge", async () => {
  const contents = await readFile(path.join(process.cwd(), "skills", "codepatrol-ship", "SKILL.md"), "utf8");
  assert.match(contents, /single integration commit on the base/);
  assert.match(contents, /base received no commit/);
  assert.doesNotMatch(contents, /report\.json/);
});

for (const adapter of adapters) {
  test(`exposes ${adapter.harness} lifecycle skill proxies`, async () => {
    const directory = path.join(process.cwd(), adapter.directory);
    const files = (await readdir(directory)).filter((name) => name.endsWith(".md")).sort();
    assert.deepEqual(files, commandNames.map((name) => `codepatrol-${name}.md`).sort());

    for (const name of skillNames) {
      const contents = await readFile(path.join(directory, `codepatrol-${name}.md`), "utf8");
      assert.match(contents, /^---\ndescription: .+\n---\n/);
      assert.match(contents, /\$ARGUMENTS/);
      assert.match(contents, new RegExp("project skill `codepatrol-" + name + "`"));
      assert.match(contents, new RegExp("harness is `" + adapter.harness + "`"));
      assert.doesNotMatch(contents, new RegExp(`codepatrol ${name} (start|trace|complete|apply)`));
    }

  });
}

test("registers the generic skill directory with OpenCode", async () => {
  const config = JSON.parse(await readFile(path.join(process.cwd(), "opencode.json"), "utf8")) as {
    $schema?: string;
    skills?: { paths?: string[] };
  };
  assert.equal(config.$schema, "https://opencode.ai/config.json");
  assert.deepEqual(config.skills?.paths, ["./skills"]);
});

test("links the generic skill directory into the Claude adapter", async () => {
  const directory = path.join(process.cwd(), ".claude", "skills");
  const entries = (await readdir(directory)).sort();
  assert.deepEqual(entries, skillNames.map((name) => `codepatrol-${name}`).sort());

  for (const name of skillNames) {
    const target = await readlink(path.join(directory, `codepatrol-${name}`));
    assert.equal(target, `../../skills/codepatrol-${name}`);
  }
});
