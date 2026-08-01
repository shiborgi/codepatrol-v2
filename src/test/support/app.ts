import { ChangeIntegration } from "../../adapters/integration.js";
import { GitManifestStore } from "../../adapters/manifest-store.js";
import { LocalGitPort } from "../../adapters/git-port.js";
import { Worktrees, worktreeStoreHooks } from "../../adapters/worktree.js";
import type { GitRemote } from "../../application/ports.js";
import { ALL_PROJECTIONS, type Projections } from "../../application/projections.js";
import { PublicationService } from "../../application/publication.js";
import { SpecService } from "../../application/spec-service.js";
import { InitiativeService } from "../../application/initiative-service.js";
import { WorkService, type Clock, type ResultInput } from "../../application/work-service.js";
import { defaultIssueClassification } from "../../core/work-type-labels.js";
import type { IssueType, Stage } from "../../core/types.js";
import { INITIATIVE_DOCUMENT_SCHEMA_VERSION, INITIATIVE_DOCUMENT_TYPE, type InitiativeDocument } from "../../core/initiative-document.js";
import { FakeGitHub, FakeRemote } from "./github.js";
import { createTestRepo, type TestRepo, type TestRepoOptions } from "./repo.js";

/** Deterministic clock: one second per call, so timestamps are stable and ordered. */
export class TestClock implements Clock {
  private tick = 0;

  now(): Date {
    const date = new Date(Date.UTC(2026, 6, 29, 10, 0, this.tick));
    this.tick += 1;
    return date;
  }
}

export const TODO = [{ id: "T1", title: "Produce the step result" }];
export const DONE_TODO = [{ id: "T1", status: "completed" as const }];

export interface TestApp {
  readonly repo: TestRepo;
  readonly clock: TestClock;
  readonly github: FakeGitHub;
  readonly remote: GitRemote;
  readonly store: GitManifestStore;
  readonly worktrees: Worktrees;
  readonly works: WorkService;
  readonly publication: PublicationService;
  readonly spec: SpecService;
  readonly initiatives: InitiativeService;
  createWork(input?: { type?: IssueType; title?: string; description?: string; priority?: "p0" | "p1" | "p2" | "p3"; requestedBy?: string; blockedBy?: string[] }): Promise<string>;
  runStage(stage: Stage, workId: string, result?: Partial<ResultInput>): Promise<{ runId: string; worktreeDirectory: string | null }>;
  runThrough(workId: string, lastStage?: Stage, perStage?: Partial<Record<Stage, Partial<ResultInput>>>): Promise<void>;
  cleanup(): Promise<void>;
}

export interface TestAppOptions extends TestRepoOptions {
  /** Repository the fake remote resolves to; omit for a repository with no remote. */
  remoteRepository?: string;
  remote?: GitRemote;
  github?: FakeGitHub;
  /** Projections the repository configuration enables; omit for all of them. */
  projections?: Projections;
}

const STAGE_ORDER: readonly Stage[] = ["plan", "review", "build", "verify", "ship"];

export async function createTestApp(options: TestAppOptions = {}): Promise<TestApp> {
  const { remoteRepository, remote: providedRemote, github: providedGithub, projections, ...repoOptions } = options;
  const repo = await createTestRepo(repoOptions);
  const clock = new TestClock();
  const github = providedGithub ?? new FakeGitHub();
  const remote = providedRemote ?? new FakeRemote(remoteRepository);
  const worktrees = new Worktrees(repo.root);
  const store = new GitManifestStore(repo.root, worktreeStoreHooks(worktrees));
  const works = new WorkService(store, worktrees, new ChangeIntegration(repo.root, worktrees), new LocalGitPort(repo.root), clock, repo.root);
  const publication = new PublicationService(store, remote, github, github.labelsPort, github, github.milestonesPort, defaultIssueClassification(), projections ?? ALL_PROJECTIONS);
  const initiatives = new InitiativeService(store);
  const spec = new SpecService(store, worktrees, clock);

  const app: TestApp = {
    repo,
    clock,
    github,
    remote,
    store,
    worktrees,
    works,
    publication,
    spec,
    initiatives,
    async createWork(input = {}) {
      const inspection = await spec.inspect();
      const declared = (await initiatives.list()).length > 0;
      const document: InitiativeDocument = {
        schemaVersion: INITIATIVE_DOCUMENT_SCHEMA_VERSION,
        type: INITIATIVE_DOCUMENT_TYPE,
        documentId: `test-create-${inspection.digest.slice(0, 12)}`,
        summary: "Create test Work through Spec",
        observedState: "test fixture",
        digest: inspection.digest,
        createdAt: clock.now().toISOString(),
        works: [{
          key: "work",
          title: input.title ?? "Replace orchestration",
          description: input.description ?? "Test Work",
          issueType: input.type ?? "Task",
          priority: input.priority ?? "p1",
          acceptance: ["The test contract is satisfied"],
          blockedBy: (input.blockedBy ?? []).map((id) => ({ kind: "id" as const, id })),
          requestedBy: input.requestedBy ?? "test",
        }],
        cancel: [],
        supersede: [],
        followUp: [],
        ...(declared ? {} : { initiative: { title: "Test initiative", intent: "i", motivation: "m", ordering: "o" } }),
      };
      const applied = await spec.apply(document);
      return applied.createdWorkIds?.[0] as string;
    },
    async runStage(stage, workId, result = {}) {
      const started = await works.start(stage, workId, "test-harness", "test-model", TODO);
      const decision = result.decision ?? (stage === "ship" ? "accept" : "continue");
      await works.complete(stage, workId, started.runId, {
        decision,
        summary: `${stage} complete`,
        handoff: `${stage} handoff`,
        todo: DONE_TODO,
        artifacts: [],
        ...(decision === "accept" || decision === "rollback" ? { authority: "test-authority" } : {}),
        ...result,
      });
      return { runId: started.runId, worktreeDirectory: started.worktreeDirectory };
    },
    /** Runs from wherever the Work currently stands through `lastStage`. */
    async runThrough(workId, lastStage = "ship", perStage = {}) {
      const from = STAGE_ORDER.indexOf((await works.show(workId)).stage);
      for (const stage of STAGE_ORDER.slice(from, STAGE_ORDER.indexOf(lastStage) + 1)) {
        await app.runStage(stage, workId, perStage[stage] ?? {});
      }
    },
    cleanup: () => repo.cleanup(),
  };
  return app;
}
