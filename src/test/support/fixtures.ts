import { INITIATIVE_DOCUMENT_SCHEMA_VERSION, INITIATIVE_DOCUMENT_TYPE } from "../../core/initiative-document.js";
import { graphDigest } from "../../core/work-graph.js";
import type { Stage, WorkInitiative, WorkOrigin, WorkOutcome } from "../../core/types.js";
import type { WorkManifest } from "../../core/work-manifest.js";

/**
 * The provenance every test Work carries.
 *
 * Origin is required on a real Work, so tests declare one explicitly rather
 * than letting the service invent it: a fabricated provenance in the ledger is
 * exactly what the field exists to prevent.
 */
export const TEST_ORIGIN: WorkOrigin = {
  createdAt: "2026-07-29T10:00:00.000Z",
};

/** The Initiative every test Work belongs to; ids are `INIT-0.1-<slug>`. */
export const TEST_INITIATIVE: WorkInitiative = {
  id: "INIT-0",
  position: 1,
};

const FIXTURE_COMMIT = "a".repeat(40);
/**
 * Shared between `manifestFixture` and `CREATE_FIELDS` so an `id`-referenced
 * Work that spreads `CREATE_FIELDS` without overriding `description` restates
 * the fixture's current value verbatim — the document's way of saying "no
 * change" to a field it must still declare in full.
 */
const FIXTURE_DESCRIPTION = "What it does";

export function fixtureId(name: string): string {
  return `INIT-0.1-${name}`;
}

export interface ManifestFixtureOptions {
  blockedBy?: string[];
  outcome?: WorkOutcome;
  active?: boolean;
  stage?: Stage;
  /** Whether the Work has attempts behind it, which restricts how Spec may change it. */
  started?: boolean;
}

/**
 * A manifest shaped only as far as the graph and the document differ read
 * it. Neither parses, so building a full lifecycle history here would obscure
 * what is under test rather than strengthen it.
 */
export function manifestFixture(name: string, options: ManifestFixtureOptions = {}): WorkManifest {
  const stage = options.stage ?? "plan";
  const started = options.started ?? (options.active === true || options.stage !== undefined);
  return {
    schemaVersion: 1,
    type: "codepatrol-work",
    work: {
      id: fixtureId(name),
      title: `Work ${name}`,
      description: FIXTURE_DESCRIPTION,
      issueType: "Task",
      priority: "p2",
      acceptance: ["It works"],
      createdAt: "2026-07-31T03:00:00.000Z",
      requestedBy: "local-user",
      initiative: TEST_INITIATIVE,
      origin: TEST_ORIGIN,
    },
    repository: { baseRef: "refs/heads/main", createdFromCommit: FIXTURE_COMMIT, baselineCommit: FIXTURE_COMMIT },
    graph: { blockedBy: (options.blockedBy ?? []).map(fixtureId).sort() },
    issue: null,
    workflow: {
      state: options.outcome === undefined ? (options.active === true ? "active" : "ready") : "terminal",
      stage,
      attempt: 1,
      updatedAt: "2026-07-31T03:00:00.000Z",
    },
    attempts: started
      ? [{
        stage,
        attempt: 1,
        runId: "11111111-1111-4111-8111-111111111111",
        status: options.active === true ? "active" : "completed",
        execution: { role: "planner", harness: "test", model: "test-model" },
        startedAt: "2026-07-31T03:01:00.000Z",
        todo: [{ id: "T1", title: "Do it" }],
      }]
      : [],
    completion: options.outcome === undefined ? null : {
      outcome: options.outcome,
      via: options.outcome === "accepted" || options.outcome === "rolled-back" ? "ship" : "spec",
      authority: "release-owner",
      finalizedAt: "2026-07-31T04:00:00.000Z",
      summary: "done",
      ...(options.outcome === "superseded" ? { replacedBy: [fixtureId("replacement")] } : {}),
    },
  };
}

/** An Initiative document already pinned to `manifests`, so only its contents are under test. */
export function documentFixture(manifests: readonly WorkManifest[], works: unknown[], overrides: Record<string, unknown> = {}): unknown {
  return {
    schemaVersion: INITIATIVE_DOCUMENT_SCHEMA_VERSION,
    type: INITIATIVE_DOCUMENT_TYPE,
    documentId: "document-test",
    summary: "A document under test",
    observedState: "The graph as read by the test",
    digest: graphDigest(manifests),
    createdAt: "2026-07-31T05:00:00.000Z",
    works,
    ...overrides,
  };
}

export const CREATE_FIELDS = {
  title: "A new Work",
  description: FIXTURE_DESCRIPTION,
  issueType: "Task",
  priority: "p2",
  acceptance: ["The behaviour is demonstrably correct"],
};
