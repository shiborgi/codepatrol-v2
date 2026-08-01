import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * The INIT-0 sweep removed the proposal machinery, the retrospective schema,
 * and the improvement-signal machinery. This test fails if any of them creep
 * back in, so the sweep cannot silently regress. It scans identifiers that only
 * the removed machinery used — never bare words a legitimate sentence might
 * need (the architecture may still say there is *no* retrospective).
 */
const FORBIDDEN = [
  // The proposal document type and its error codes.
  "codepatrol-proposal",
  "PROPOSAL_REJECTED",
  "STALE_PROPOSAL",
  "proposalId",
  // Removed origin fields.
  "batchId",
  "proposalDigest",
  "intentDigest",
  "OriginKind",
  "ORIGIN_KINDS",
  // The removed manifest field.
  "changeProjection",
  // The improvement-signal machinery.
  "ImprovementService",
  "improvementCandidates",
  "improvementSignals",
  "ImprovementOrigin",
  "ImprovementProvenance",
  "IMPROVEMENT_KEY",
  // The retrospective schema.
  "parseRetrospective",
  "renderRetrospective",
  "WorkRetrospective",
  "EMPTY_RETROSPECTIVE_INPUT",
  "RetrospectiveInput",
  "retrospectiveSummary",
  // The removed Pull Request projection.
  "GitHubPullRequest",
  "pull-request-permission",
];

async function trackedFiles(): Promise<string[]> {
  const roots = ["src", "docs", "skills", "examples", "scripts"];
  const found: string[] = [];
  const { readdir } = await import("node:fs/promises");
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (/\.(ts|mjs|md|json)$/.test(entry.name)) found.push(absolute);
    }
  };
  for (const root of roots) await walk(path.join(process.cwd(), root));
  found.push(path.join(process.cwd(), "README.md"), path.join(process.cwd(), "CHANGELOG.md"), path.join(process.cwd(), "SECURITY.md"));
  return found;
}

test("no removed machinery reappears anywhere in the tree", async () => {
  const self = path.join(process.cwd(), "src", "test", "vocabulary.test.ts");
  const offenders: string[] = [];
  for (const file of await trackedFiles()) {
    if (file === self) continue;
    const contents = await readFile(file, "utf8");
    for (const term of FORBIDDEN) {
      if (contents.includes(term)) offenders.push(`${path.relative(process.cwd(), file)}: ${term}`);
    }
  }
  assert.deepEqual(offenders, [], "removed machinery reappeared");
});
