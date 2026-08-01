import assert from "node:assert/strict";
import test from "node:test";
import { boundedTail, outputEvidence, redact, REDACTED } from "../core/redaction.js";
import { sha256 } from "../core/json.js";
import { manifestPath } from "../core/work-manifest.js";
import { createTestApp, TODO, DONE_TODO } from "./support/app.js";

/**
 * Reconstructed at runtime so the credential is in the program's *output*, not
 * in the command line. `requiredCommands` come from `.codepatrol/policy.json`,
 * which is already committed — a secret embedded there was leaked before
 * Codepatrol ever ran.
 */
const SCRIPT_PRINTING_A_SECRET = 'console.log("token=" + ["ghp", "abcdefghij0123456789ABCDEFGHIJ"].join("_"))';

const SECRETS: ReadonlyArray<{ label: string; text: string; leak: string }> = [
  { label: "GitHub token", text: "auth failed for ghp_abcdefghij0123456789ABCDEFGHIJ", leak: "ghp_abcdefghij0123456789ABCDEFGHIJ" },
  { label: "GitHub fine-grained token", text: "using github_pat_11ABCDEFG0aBcDeFgHiJkLmNoPqRsTuV", leak: "github_pat_11ABCDEFG0aBcDeFgHiJkLmNoPqRsTuV" },
  { label: "AWS access key id", text: "key AKIAIOSFODNN7EXAMPLE denied", leak: "AKIAIOSFODNN7EXAMPLE" },
  { label: "AWS secret", text: "aws_secret_access_key=wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY", leak: "wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY" },
  { label: "bearer header", text: "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9payload", leak: "eyJhbGciOiJIUzI1NiJ9payload" },
  { label: "JWT", text: "token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk", leak: "eyJzdWIiOiIxMjM0NTY3ODkwIn0" },
  { label: "password assignment", text: "DB_PASSWORD=hunter2-not-in-the-log", leak: "hunter2-not-in-the-log" },
  { label: "api key in JSON", text: '{"api_key": "sk_live_51H8xKLMNOPqrstuvwxyz01"}', leak: "sk_live_51H8xKLMNOPqrstuvwxyz01" },
  { label: "URL credential", text: "cloning https://ci-bot:s3cr3t-token-value@github.com/owner/repo.git", leak: "s3cr3t-token-value" },
  { label: "Slack token", text: "posting with xoxb-1234567890-abcdefghijkl", leak: "xoxb-1234567890-abcdefghijkl" },
  { label: "Google key", text: "maps AIzaSyA1234567890abcdefghijklmnopqrstuv", leak: "AIzaSyA1234567890abcdefghijklmnopqrstuv" },
  {
    label: "PEM private key",
    text: "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAxDeadBeef\n-----END RSA PRIVATE KEY-----",
    leak: "MIIEowIBAAKCAQEAxDeadBeef",
  },
];

test("redacts every credential shape that shows up in build output", () => {
  for (const { label, text, leak } of SECRETS) {
    const { text: cleaned, count } = redact(text);
    assert.ok(!cleaned.includes(leak), `${label} survived redaction: ${cleaned}`);
    assert.ok(count > 0, `${label} was not counted as a redaction`);
    assert.ok(cleaned.includes(REDACTED), `${label} left no marker that something was removed`);
  }
});

test("leaves ordinary output untouched", () => {
  const output = "12 passing (340ms)\n  ok  the parser rejects an unknown field\nBuild succeeded in 2.1s\n";
  const { text, count } = redact(output);
  assert.equal(text, output);
  assert.equal(count, 0);
});

test("keeps the tail, because that is where a failure explains itself", () => {
  const long = `${"noise line\n".repeat(5_000)}FAIL: the assertion that matters\n`;
  const { text, truncated } = boundedTail(long, 256);
  assert.equal(truncated, true);
  assert.ok(text.includes("FAIL: the assertion that matters"));
  assert.ok(Buffer.byteLength(text) <= 256);
  assert.ok(!text.startsWith("oise"), "a partial first line is dropped rather than shown mangled");

  const short = "all good\n";
  assert.deepEqual(boundedTail(short, 256), { text: short, truncated: false });
});

test("evidence keeps no output by default, only proof of what it was", () => {
  const output = `${"x".repeat(10_000)}\nghp_abcdefghij0123456789ABCDEFGHIJ\n`;
  const evidence = outputEvidence(output);

  // The conservative default: nothing from the output survives into the
  // manifest, because redaction is a net and the manifest is permanent.
  assert.equal(evidence.excerpt, undefined);
  assert.equal(evidence.digest, sha256(output), "the digest still identifies the exact bytes");
  assert.equal(evidence.bytes, Buffer.byteLength(output));
  assert.equal(evidence.truncated, true);
  assert.equal(evidence.redactions, 1, "it still reports that a credential was present");
});

test("an opted-in excerpt is bounded and redacted", () => {
  const output = `${"x".repeat(10_000)}\nghp_abcdefghij0123456789ABCDEFGHIJ\n`;
  const evidence = outputEvidence(output, { excerpt: true, limit: 512 });

  assert.ok(evidence.excerpt !== undefined);
  assert.ok(Buffer.byteLength(evidence.excerpt) <= 512);
  assert.ok(!evidence.excerpt.includes("ghp_abcdefghij0123456789ABCDEFGHIJ"));
  assert.equal(evidence.redactions, 1);
});

test("a Verify command's raw output never reaches the manifest or the base", async () => {
  const leak = "ghp_abcdefghij0123456789ABCDEFGHIJ";
  // A required command that prints a credential, as a careless test would.
  const app = await createTestApp({
    defaultBranch: "trunk",
    verifyPolicy: { verify: { requiredCommands: [["node", "-e", SCRIPT_PRINTING_A_SECRET]] } },
  });
  try {
    const workId = await app.createWork();
    await app.runThrough(workId, "build");
    const started = await app.works.start("verify", workId, "test-harness", "test-model", TODO);
    await app.works.complete("verify", workId, started.runId, {
      decision: "continue", summary: "verified", handoff: "ship it", todo: DONE_TODO, artifacts: [],
    });

    const attempt = (await app.works.show(workId)).attempts.find((item) => item.runId === started.runId);
    const evidence = attempt?.traces?.find((item) => item.type === "command");
    assert.ok(evidence, "the command was recorded");

    const serialized = JSON.stringify(evidence);
    assert.ok(!serialized.includes(leak), `the credential reached the manifest: ${serialized}`);
    const stdout = evidence.data?.stdout as { digest: string; excerpt?: string; redactions: number };
    assert.match(stdout.digest, /^[0-9a-f]{64}$/, "the record still identifies what was produced");
    assert.ok(stdout.redactions > 0, "the record says something was removed");
    assert.equal(stdout.excerpt, undefined, "by default no output is kept at all");
    assert.ok((evidence.data?.outputLog as string).startsWith(".codepatrol/runtime/"), "the full output stays in the disposable runtime");

    // The decisive check: the manifest reaches the base branch through the
    // accept squash, so anything in it is permanent and published.
    await app.runThrough(workId, "ship");
    const inBase = await app.repo.showFile("refs/heads/trunk", manifestPath(workId));
    assert.ok(inBase !== undefined, "the accepted manifest does reach the base");
    assert.ok(!inBase.includes(leak), "the credential was committed to the base branch");
  } finally {
    await app.cleanup();
  }
});

test("a failure report quotes the output without quoting the secret", async () => {
  const leak = "ghp_abcdefghij0123456789ABCDEFGHIJ";
  const script = `${SCRIPT_PRINTING_A_SECRET.replace("console.log", "console.error")}; process.exit(3)`;
  const app = await createTestApp({
    defaultBranch: "trunk",
    verifyPolicy: { verify: { requiredCommands: [["node", "-e", script]] } },
  });
  try {
    const workId = await app.createWork();
    await app.runThrough(workId, "build");
    const started = await app.works.start("verify", workId, "test-harness", "test-model", TODO);
    await assert.rejects(
      app.works.complete("verify", workId, started.runId, {
        decision: "continue", summary: "verified", handoff: "ship it", todo: DONE_TODO, artifacts: [],
      }),
      (error: unknown) => {
        const rendered = JSON.stringify(error instanceof Error ? { ...error, message: error.message } : error);
        assert.ok(!rendered.includes(leak), `the failure report leaked the credential: ${rendered}`);
        return true;
      },
    );
  } finally {
    await app.cleanup();
  }
});
