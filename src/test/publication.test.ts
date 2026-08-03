import assert from "node:assert/strict";
import test from "node:test";
import { CodepatrolError } from "../core/errors.js";
import { workCodeOf } from "../core/identifiers.js";
import { createTestApp, DONE_TODO, TODO, type TestApp } from "./support/app.js";
import { INITIATIVE_DOCUMENT_SCHEMA_VERSION, INITIATIVE_DOCUMENT_TYPE, parseInitiativeDocument, type InitiativeDocument } from "../core/initiative-document.js";
import { FakeGitHub, FakeRemote } from "./support/github.js";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { readProjections, readPublicationSettings, type Projections } from "../application/projections.js";
import { REPOSITORY_CONFIG_PATH, REPOSITORY_CONFIG_SCHEMA_VERSION, serializeRepositoryConfig, type RepositoryConfig } from "../core/repository-config.js";
import { defaultIssueClassification } from "../core/work-type-labels.js";

async function specDocument(app: TestApp, actions: unknown[]): Promise<InitiativeDocument> {
  const inspection = await app.spec.inspect();
  const declared = (await app.initiatives.list()).length > 0;
  const works = actions.filter((action) => (action as { type: string }).type === "create").map((action) => {
    const { type: _type, ...rest } = action as Record<string, unknown>;
    return rest;
  });
  return parseInitiativeDocument({
    schemaVersion: INITIATIVE_DOCUMENT_SCHEMA_VERSION,
    type: INITIATIVE_DOCUMENT_TYPE,
    documentId: "document-publication",
    summary: "A document under test",
    observedState: "as inspected",
    digest: inspection.digest,
    createdAt: "2026-07-31T05:00:00.000Z",
    works,
    ...(declared ? {} : { initiative: { title: "Publication fixture", intent: "i", motivation: "m", ordering: "o" } }),
  });
}


const REPOSITORY = "shiborgi/codepatrol";

test("validates a selected Work before skipping an absent remote", async () => {
  const app = await createTestApp();
  try {
    await assert.rejects(
      app.publication.automatic({ workId: "INIT-0.9-missing" }),
      (error: unknown) => error instanceof CodepatrolError && error.code === "WORK_NOT_FOUND",
    );
  } finally {
    await app.cleanup();
  }
});

test("a scoped publication accepts the short INIT-x.y code and publishes only that Work", async () => {
  // The scope filter downstream of the resolver must receive the canonical id,
  // not the short code, so the scoping behavior is identical to passing the
  // full id: the selected Work is published and nothing else is touched.
  const app = await createTestApp({ remoteRepository: REPOSITORY });
  try {
    const workA = await app.createWork({ title: "Work A" });
    const workB = await app.createWork({ title: "Work B" });
    const shortA = workA.match(/^(INIT-\d+\.\d+)-/)?.[1] ?? workA;
    const shortB = workB.match(/^(INIT-\d+\.\d+)-/)?.[1] ?? workB;

    const result = await app.publication.reconcile({ repository: REPOSITORY, remote: "origin", workId: shortB });

    assert.equal(result.issues.created.length, 1, "the scoped publication creates only the targeted Issue");
    assert.deepEqual(result.issues.created[0], { issue: 1, workId: workB });
    assert.equal(app.github.issues.length, 1, "the unselected Work is not touched");
    assert.notEqual(shortA, shortB, "the two Works have distinct short codes, so the test actually exercises resolution");
  } finally {
    await app.cleanup();
  }
});

test("completes the whole lifecycle with no remote configured", async () => {
  // The defining property: GitHub is a projection, so its absence is a
  // supported way to run rather than a degraded one.
  const app = await createTestApp({ defaultBranch: "trunk" });
  try {
    const workId = await app.createWork({ title: "No remote at all" });
    const initiativeRef = "refs/codepatrol/initiative/INIT-0-test-initiative";
    const initiativeHeadBefore = await app.repo.head(initiativeRef);
    assert.equal(await app.publication.automatic({ workId }), undefined);

    await app.runThrough(workId);

    const view = await app.works.show(workId);
    assert.equal(view.outcome, "accepted");
    assert.ok(view.change.verification);
    assert.equal(view.change.verification.baselineCommit, view.repository.baselineCommit);
    assert.equal(await app.repo.commitCount("refs/heads/trunk"), 3, "bootstrap, the manifest projection, and the squash");
    assert.equal(app.github.calls.length, 0, "nothing reached GitHub");
    assert.equal(await app.repo.head(initiativeRef), initiativeHeadBefore, "a no-remote publication never touches the local Initiative ref");
  } finally {
    await app.cleanup();
  }
});

test("creates one labeled issue per Work, persists its link, and converges", async () => {
  const app = await createTestApp({ remoteRepository: REPOSITORY });
  try {
    const workId = await app.createWork({ type: "Bug", title: "Local Work", description: "Local details" });

    const first = await app.publication.reconcile({ repository: REPOSITORY, remote: "origin" });
    assert.deepEqual(first.issues.created, [{ issue: 1, workId }]);
    assert.match(app.github.issues[0]?.body ?? "", /Local details/);
    assert.match(app.github.issues[0]?.body ?? "", /<!-- codepatrol:work:start -->[\s\S]*- Type: `Bug`[\s\S]*<!-- codepatrol:work:end -->/);
    assert.match(app.github.issues[0]?.body ?? "", /<!-- codepatrol-work-id:/);
    assert.equal(app.github.issues[0]?.title, `${workCodeOf(workId)}: Local Work`, "the Issue opens with the Work id prefixed in the title");
    assert.deepEqual(app.github.issues[0]?.labels, ["codepatrol:type/bug"]);
    assert.deepEqual(first.warnings, []);
    assert.deepEqual((await app.store.read(workId)).manifest.issue, { repository: REPOSITORY, number: 1 });
    assert.equal(app.github.statuses.get(app.github.issues[0]?.url ?? ""), "Backlog");

    const edits = app.github.calls.filter((call) => call.op === "edit").length;
    const second = await app.publication.reconcile({ repository: REPOSITORY, remote: "origin" });
    assert.equal(second.issues.created.length, 0);
    assert.deepEqual(second.issues.unchanged, [{ issue: 1, workId }]);
    assert.deepEqual(second.warnings, [], "a converged issue produces no drift warnings");
    assert.equal(app.github.issues.length, 1);
    assert.equal(app.github.calls.filter((call) => call.op === "edit").length, edits, "repeated sync does not edit a converged issue");
  } finally {
    await app.cleanup();
  }
});

test("an Issue linked before the title change is reconciled to carry the Work id on the next sync", async () => {
  // A pre-change Issue is the one the system opened before this Work changed
  // its title projection: the body marker and the issue link identify it as
  // the Work's, but the title is the bare Work title. The next sync retitles
  // it to the managed form so an Issue list reads the Work's id first.
  const app = await createTestApp({ remoteRepository: REPOSITORY });
  try {
    const workId = await app.createWork({ title: "Bare-titled Work" });
    await app.publication.reconcile({ repository: REPOSITORY, remote: "origin" });
    app.github.issue(1).title = "Bare-titled Work";

    const result = await app.publication.reconcile({ repository: REPOSITORY, remote: "origin" });

    assert.deepEqual(result.issues.updated, [{ issue: 1, workId }], "the linked Issue is reconciled, not duplicated");
    assert.equal(app.github.issue(1).title, `${workCodeOf(workId)}: Bare-titled Work`, "the title is reconciled to the managed form");
  } finally {
    await app.cleanup();
  }
});

test("a repeated sync leaves the prefixed title untouched with no edit churn", async () => {
  // Convergence: once the title carries the Work id, the comparison in
  // reconcileIssueContent makes no further edit. The first sync after a
  // retitle may edit, but a second one is a no-op on the title.
  const app = await createTestApp({ remoteRepository: REPOSITORY });
  try {
    const workId = await app.createWork({ title: "Convergent Work" });
    await app.publication.reconcile({ repository: REPOSITORY, remote: "origin" });
    app.github.issue(1).title = "Convergent Work";
    await app.publication.reconcile({ repository: REPOSITORY, remote: "origin" });
    assert.equal(app.github.issue(1).title, `${workCodeOf(workId)}: Convergent Work`);

    const editsBefore = app.github.calls.filter((call) => call.op === "edit").length;
    const result = await app.publication.reconcile({ repository: REPOSITORY, remote: "origin" });

    assert.deepEqual(result.issues.unchanged, [{ issue: 1, workId }], "a converged Issue is reported unchanged");
    assert.equal(app.github.calls.filter((call) => call.op === "edit").length, editsBefore, "no edit call is made on a converged title");
    assert.equal(app.github.issue(1).title, `${workCodeOf(workId)}: Convergent Work`, "the title stays prefixed");
  } finally {
    await app.cleanup();
  }
});

test("retitling an Issue never causes a duplicate to be opened on a subsequent sync", async () => {
  // Matching keys on the body marker, the stored issue link, and requestedBy —
  // never on the title — so a retitled Issue still maps to its Work and no
  // second Issue is opened on the next sync. The title is reconciled back to
  // the managed form, which is the only edit the sync records.
  const app = await createTestApp({ remoteRepository: REPOSITORY });
  try {
    const workId = await app.createWork({ title: "Retitled Work" });
    await app.publication.reconcile({ repository: REPOSITORY, remote: "origin" });
    app.github.issue(1).title = "A human editor changed the title";

    const result = await app.publication.reconcile({ repository: REPOSITORY, remote: "origin" });

    assert.equal(result.issues.created.length, 0, "no new Issue is opened for the Work whose title changed");
    assert.deepEqual(result.issues.updated, [{ issue: 1, workId }], "the existing Issue is reconciled to the managed title");
    assert.equal(app.github.issues.length, 1, "still exactly one Issue exists for the Work");
    assert.equal(app.github.issue(1).title, `${workCodeOf(workId)}: Retitled Work`, "the title is restored to the prefixed form");
  } finally {
    await app.cleanup();
  }
});

test("projects the Initiative onto one Milestone and attaches every Work's Issue", async () => {
  const app = await createTestApp({ remoteRepository: REPOSITORY });
  try {
    const first = await app.createWork({ title: "First Work" });
    const second = await app.createWork({ title: "Second Work" });

    const result = await app.publication.reconcile({ repository: REPOSITORY, remote: "origin" });

    assert.equal(result.milestones.length, 1, "one Initiative, one Milestone");
    const milestone = app.github.milestones[0];
    assert.ok(milestone);
    assert.match(milestone.description, /<!-- codepatrol:initiative:start -->[\s\S]*<!-- codepatrol:initiative:end -->/);
    assert.match(milestone.description, new RegExp(first));
    assert.match(milestone.description, new RegExp(second));
    const attached = app.github.issues.filter((issue) => (issue as { milestone?: number }).milestone === milestone.number);
    assert.equal(attached.length, 2, "both Issues are attached to the Milestone");

    // Re-running converges: the managed section is unchanged, no new Milestone.
    const ensures = app.github.calls.filter((call) => call.op === "milestone.ensure").length;
    const again = await app.publication.reconcile({ repository: REPOSITORY, remote: "origin" });
    assert.equal(again.milestones.length, 1);
    assert.equal(app.github.milestones.length, 1, "no duplicate Milestone");
    assert.equal(app.github.calls.filter((call) => call.op === "milestone.attach").length, 4, "attach is called but is a no-op when already attached");
    assert.ok(app.github.calls.filter((call) => call.op === "milestone.ensure").length > ensures, "ensure re-checks convergence");

    // Human text outside the managed section survives a re-projection.
    milestone.description = `Reviewer notes added by hand.\n\n${milestone.description}`;
    await app.publication.reconcile({ repository: REPOSITORY, remote: "origin" });
    assert.match(app.github.milestones[0]?.description ?? "", /Reviewer notes added by hand\./);
    assert.match(app.github.milestones[0]?.description ?? "", /<!-- codepatrol:initiative:start -->/);
  } finally {
    await app.cleanup();
  }
});

test("skips the Milestone projection when it is disabled", async () => {
  const app = await createTestApp({ remoteRepository: REPOSITORY, projections: { refs: true, issue: true, milestone: false, project: false } });
  try {
    await app.createWork({ title: "No milestone" });
    const result = await app.publication.reconcile({ repository: REPOSITORY, remote: "origin" });
    assert.equal(result.issues.created.length, 1, "the Issue is still created");
    assert.deepEqual(result.milestones, []);
    assert.equal(app.github.milestones.length, 0);
  } finally {
    await app.cleanup();
  }
});

test("leaves an Issue that belongs to no Work alone", async () => {
  const github = new FakeGitHub();
  github.seedIssue({ number: 7, title: "Someone else's issue", body: "Issue details", labels: ["bug"] });
  const app = await createTestApp({ remoteRepository: REPOSITORY, github });
  try {
    const result = await app.publication.reconcile({ repository: REPOSITORY, remote: "origin" });

    // Works come only from Spec, so sync must never turn an Issue into one.
    assert.deepEqual(result.issues.unclaimed, [7]);
    assert.deepEqual(await app.works.list(), []);
    assert.equal(github.issue(7).body, "Issue details", "the Issue was not marked either");
  } finally {
    await app.cleanup();
  }
});

test("links a Spec-created Work to the Issue it was proposed from", async () => {
  const github = new FakeGitHub();
  github.seedIssue({ number: 7, title: "Fix the thing", body: "Issue details", labels: ["bug"] });
  const app = await createTestApp({ remoteRepository: REPOSITORY, github });
  try {
    // The proposer read the Issue and recorded where the demand came from; the
    // Core never called GitHub to do it.
    const applied = await app.spec.apply(await specDocument(app, [{
      type: "create",
      key: "from-issue",
      title: "Fix the thing",
      description: "Issue details",
      issueType: "Feature",
      priority: "p1",
      acceptance: ["The thing is fixed"],
      requestedBy: `github:${REPOSITORY}#7`,
    }]));
    const workId = (applied.createdWorkIds ?? [])[0] as string;

    const result = await app.publication.reconcile({ repository: REPOSITORY, remote: "origin" });

    assert.deepEqual(result.issues.unclaimed, [], "the Issue is now claimed by its Work");
    assert.match(github.issue(7).body, new RegExp(`codepatrol-work-id: ${workId}`));
    assert.deepEqual((await app.store.read(workId)).manifest.issue, { repository: REPOSITORY, number: 7 });
    assert.equal((await app.works.show(workId)).identity.issueType, "Feature");
    // No second Issue was opened for a Work that already had one.
    assert.equal(github.issues.length, 1);
  } finally {
    await app.cleanup();
  }
});

test("restores a linked issue's managed label from the manifest", async () => {
  const app = await createTestApp({ remoteRepository: REPOSITORY });
  try {
    const workId = await app.createWork({ type: "Feature", title: "Typed Work" });
    await app.publication.reconcile({ repository: REPOSITORY, remote: "origin" });
    app.github.issue(1).labels = ["codepatrol:type/bug"];

    const result = await app.publication.reconcile({ repository: REPOSITORY, remote: "origin", workId });

    assert.deepEqual(app.github.issue(1).labels, ["codepatrol:type/feature"]);
    assert.deepEqual(result.issues.updated, [{ issue: 1, workId }]);
    assert.deepEqual(result.warnings.map((warning) => warning.code), ["GITHUB_ISSUE_LABEL_DRIFT"]);

    const again = await app.publication.reconcile({ repository: REPOSITORY, remote: "origin", workId });
    assert.deepEqual(again.warnings, [], "reconciled drift does not repeat");
  } finally {
    await app.cleanup();
  }
});

test("replaces only managed labels and preserves user labels on a type change", async () => {
  const app = await createTestApp({ remoteRepository: REPOSITORY });
  try {
    const workId = await app.createWork({ type: "Bug", title: "Reclassified" });
    await app.publication.reconcile({ repository: REPOSITORY, remote: "origin" });
    app.github.issue(1).labels = ["codepatrol:type/bug", "codepatrol:type/task", "security"];

    await app.publication.reconcile({ repository: REPOSITORY, remote: "origin", workId });

    assert.deepEqual(app.github.issue(1).labels, ["codepatrol:type/bug", "security"], "obsolete managed labels are removed, user labels survive");
  } finally {
    await app.cleanup();
  }
});

test("creates the Issue without the label when label management is unavailable", async () => {
  const app = await createTestApp({ remoteRepository: REPOSITORY });
  try {
    app.github.labelsUnavailable = true;
    const workId = await app.createWork({ type: "Bug", title: "Labelless" });

    const result = await app.publication.reconcile({ repository: REPOSITORY, remote: "origin" });

    assert.deepEqual(result.issues.created, [{ issue: 1, workId }], "label failure never blocks Issue creation");
    assert.deepEqual(app.github.issue(1).labels, []);
    assert.match(app.github.issue(1).body, /- Type: `Bug`/, "the managed body keeps the classification visible");
    assert.deepEqual(result.warnings.map((warning) => warning.code), ["GITHUB_ISSUE_LABEL_UNAVAILABLE"]);

    app.github.labelsUnavailable = false;
    const retried = await app.publication.reconcile({ repository: REPOSITORY, remote: "origin", workId });
    assert.deepEqual(app.github.issue(1).labels, ["codepatrol:type/bug"], "sync reapplies the label once permissions allow");
    assert.deepEqual(retried.warnings.map((warning) => warning.code), ["GITHUB_ISSUE_LABEL_DRIFT"]);
  } finally {
    await app.cleanup();
  }
});

test("scoped publication detects an Issue already linked to another Work", async () => {
  const app = await createTestApp({ remoteRepository: REPOSITORY });
  try {
    const linkedWork = await app.createWork({ title: "Already linked" });
    await app.publication.reconcile({ repository: REPOSITORY, remote: "origin", workId: linkedWork });
    const selectedWork = await app.createWork({ title: "Selected later" });
    const issue = app.github.issue(1);
    issue.body = `${issue.body}\n\n<!-- codepatrol-work-id: ${selectedWork} -->`;

    await assert.rejects(
      app.publication.reconcile({ repository: REPOSITORY, remote: "origin", workId: selectedWork }),
      (error: unknown) => error instanceof CodepatrolError && error.code === "SYNC_CONFLICT",
    );
    assert.equal((await app.store.read(selectedWork)).manifest.issue, null);
  } finally {
    await app.cleanup();
  }
});

test("scoped publication leaves unrelated Works and Issues untouched", async () => {
  const app = await createTestApp({ remoteRepository: REPOSITORY });
  try {
    const selected = await app.createWork({ title: "Selected" });
    const unrelated = await app.createWork({ title: "Unrelated" });
    await app.publication.reconcile({ repository: REPOSITORY, remote: "origin" });
    const unrelatedIssue = (await app.store.read(unrelated)).manifest.issue?.number;
    assert.ok(unrelatedIssue);

    const result = await app.publication.reconcile({ repository: REPOSITORY, remote: "origin", workId: selected });

    assert.equal(app.github.issues.length, 2);
    assert.equal((await app.store.read(unrelated)).manifest.issue?.number, unrelatedIssue);
    assert.deepEqual(result.project.statuses.map((item) => item.workId), [selected]);
    assert.equal([...result.issues.created, ...result.issues.updated, ...result.issues.unchanged].every((item) => item.workId === selected), true);
  } finally {
    await app.cleanup();
  }
});

test("tracks the stage on the board and closes the issue only when terminal", async () => {
  const app = await createTestApp({ remoteRepository: REPOSITORY });
  try {
    const workId = await app.createWork({ title: "Tracked" });
    await app.publication.reconcile({ repository: REPOSITORY, remote: "origin" });
    const issue = app.github.issues[0];
    assert.ok(issue);

    await app.runStage("plan", workId);
    const planned = await app.publication.reconcile({ repository: REPOSITORY, remote: "origin", workId });
    assert.deepEqual(planned.project.statuses, [{ workId, status: "Plan", outcome: "None" }], "the board keeps the last-attacked stage while the Work waits for the next run");
    assert.equal(app.github.issue(issue.number).state, "open");
    assert.ok(app.github.commentsFor(issue.number).some((comment) => /Codepatrol · `plan`/.test(comment.body)));

    await app.runThrough(workId);
    const shipped = await app.publication.reconcile({ repository: REPOSITORY, remote: "origin", workId });
    assert.deepEqual(shipped.project.statuses, [{ workId, status: "Done", outcome: "Accepted" }]);
    assert.equal(app.github.issue(issue.number).state, "closed");
    assert.ok(app.github.commentsFor(issue.number).some((comment) => /Codepatrol · Ship/.test(comment.body)));
  } finally {
    await app.cleanup();
  }
});

test("links a terminal rolled-back Work on its manifest ref when first published late", async () => {
  const app = await createTestApp({ remoteRepository: REPOSITORY });
  try {
    const workId = await app.createWork({ title: "Publish after rollback" });
    await app.runThrough(workId, "ship", { ship: { decision: "rollback" } });
    assert.equal((await app.store.read(workId)).source, "manifest");

    const result = await app.publication.reconcile({ repository: REPOSITORY, remote: "origin", workId });
    const linked = await app.store.read(workId);

    assert.deepEqual(result.issues.created, [{ issue: 1, workId }]);
    assert.equal(linked.source, "manifest", "the late link lands on the manifest ref; the archive is never advanced");
    assert.deepEqual(linked.manifest.issue, { repository: REPOSITORY, number: 1 });
    assert.equal(app.github.issue(1).state, "closed");
    assert.equal(app.github.statuses.get(app.github.issue(1).url), "Done");
  } finally {
    await app.cleanup();
  }
});

test("renders one comment per attempt and converges on repeated runs", async () => {
  const app = await createTestApp({ remoteRepository: REPOSITORY });
  try {
    const workId = await app.createWork({ title: "Commented" });
    await app.runStage("plan", workId);
    await app.publication.reconcile({ repository: REPOSITORY, remote: "origin", workId });
    const issue = app.github.issues[0];
    assert.ok(issue);
    const after = app.github.commentsFor(issue.number).length;

    const again = await app.publication.reconcile({ repository: REPOSITORY, remote: "origin", workId });
    assert.equal(app.github.commentsFor(issue.number).length, after, "publication is idempotent");
    assert.equal(again.comments.created.length, 0);
    assert.ok(again.comments.unchanged.length > 0);
  } finally {
    await app.cleanup();
  }
});

test("leaves the local fact intact when publication fails", async () => {
  const app = await createTestApp({ remoteRepository: REPOSITORY });
  try {
    const workId = await app.createWork({ title: "Publication fails" });
    await app.runStage("plan", workId);
    app.github.failNext("createComment");

    await assert.rejects(
      app.publication.reconcile({ repository: REPOSITORY, remote: "origin", workId }),
      (error: unknown) => error instanceof CodepatrolError && error.code === "GH_ERROR",
    );

    // The Work advanced regardless; sync converges later.
    assert.equal((await app.works.show(workId)).stage, "review");
    const recovered = await app.publication.reconcile({ repository: REPOSITORY, remote: "origin", workId });
    assert.deepEqual(recovered.project.statuses, [{ workId, status: "Plan", outcome: "None" }], "the board keeps the last-attacked stage while the Work waits for the next run");
  } finally {
    await app.cleanup();
  }
});

test("preserves human comments and issue prose", async () => {
  const app = await createTestApp({ remoteRepository: REPOSITORY });
  try {
    const workId = await app.createWork({ title: "Shared issue" });
    await app.runStage("plan", workId);
    await app.publication.reconcile({ repository: REPOSITORY, remote: "origin", workId });
    const issue = app.github.issues[0];
    assert.ok(issue);

    const human = await app.github.createComment(REPOSITORY, issue.number, "Human discussion must remain untouched.");
    app.github.issue(issue.number).body = `${issue.body.trimEnd()}\n\nHuman text appended after the marker.\n`;

    await app.runStage("review", workId);
    await app.publication.reconcile({ repository: REPOSITORY, remote: "origin", workId });

    assert.ok(app.github.commentsFor(issue.number).some((comment) => comment.id === human.id && comment.body === "Human discussion must remain untouched."));
    assert.match(app.github.issue(issue.number).body, /Human text appended after the marker\./);
    assert.match(app.github.issue(issue.number).body, new RegExp(`codepatrol-work-id: ${workId}`));
  } finally {
    await app.cleanup();
  }
});

const NOTHING: Projections = { refs: false, issue: false, milestone: false, project: false };

test("publishes nothing when the repository configuration disables every projection", async () => {
  // The defect this guards: publication used to run on any resolvable GitHub
  // remote, so a configuration that disabled every projection still created
  // Issues and Project items the repository had explicitly turned off.
  const app = await createTestApp({ remoteRepository: REPOSITORY, projections: NOTHING });
  try {
    await app.createWork({ title: "Local only" });
    assert.equal(await app.publication.automatic({}), undefined);
    assert.equal(app.github.calls.length, 0, "nothing reached GitHub");
    assert.equal((app.remote as FakeRemote).calls.length, 0, "no refs were pushed");
  } finally {
    await app.cleanup();
  }
});

test("a disabled refs projection never touches the local Initiative ref even when a remote is configured", async () => {
  // The guard: refs projection is what writes Initiative refs to the remote.
  // When the repository configuration turns it off, even with a remote
  // configured the local Initiative ref is not synced — the local record is
  // the source of truth until the projection is re-enabled.
  const app = await createTestApp({ remoteRepository: REPOSITORY, projections: NOTHING });
  try {
    await app.createWork({ title: "Refs disabled" });
    const initiativeRef = "refs/codepatrol/initiative/INIT-0-test-initiative";
    const initiativeHeadBefore = await app.repo.head(initiativeRef);
    assert.ok(initiativeHeadBefore, "the Initiative ref exists locally after the Work is created");

    const result = await app.publication.reconcile({ repository: REPOSITORY, remote: "origin" });

    assert.deepEqual(result.git.beforeIssues.refs, [], "the refs projection is disabled, so the pre-issue sync reports no activity");
    assert.deepEqual(result.git.afterIssues.refs, [], "the refs projection is disabled, so the post-issue sync reports no activity");
    assert.equal((app.remote as FakeRemote).calls.length, 0, "remote.sync is never called when refs projection is off");
    assert.equal(await app.repo.head(initiativeRef), initiativeHeadBefore, "the local Initiative ref is untouched");
  } finally {
    await app.cleanup();
  }
});

test("publishes refs without opening an Issue when the Issue projection is disabled", async () => {
  const app = await createTestApp({ remoteRepository: REPOSITORY, projections: { refs: true, issue: false, milestone: false, project: false } });
  try {
    const workId = await app.createWork({ title: "Refs only" });
    const result = await app.publication.reconcile({ repository: REPOSITORY, remote: "origin" });

    assert.equal((app.remote as FakeRemote).calls.length, 2, "refs are published before and after the projections");
    assert.deepEqual(result.issues.created, []);
    assert.equal(app.github.issues.length, 0);
    assert.equal((await app.store.read(workId)).manifest.issue, null);
  } finally {
    await app.cleanup();
  }
});

test("opens the Issue without a Project item when the Project projection is disabled", async () => {
  const app = await createTestApp({ remoteRepository: REPOSITORY, projections: { refs: true, issue: true, milestone: false, project: false } });
  try {
    const workId = await app.createWork({ title: "No board" });
    const result = await app.publication.reconcile({ repository: REPOSITORY, remote: "origin" });

    assert.deepEqual(result.issues.created, [{ issue: 1, workId }]);
    assert.deepEqual(result.project.statuses, []);
    assert.equal(app.github.calls.some((call) => call.op === "project-ensure" || call.op === "project-reconcile"), false);
  } finally {
    await app.cleanup();
  }
});

test("a workspace without configuration projects nothing", async () => {
  const app = await createTestApp();
  try {
    assert.deepEqual(await readProjections(app.repo.root), NOTHING);
  } finally {
    await app.cleanup();
  }
});

test("reads every projection toggle from the repository configuration", async () => {
  const app = await createTestApp();
  try {
    const write = async (github: RepositoryConfig["github"]): Promise<void> => {
      await mkdir(path.join(app.repo.root, ".codepatrol"), { recursive: true });
      await writeFile(path.join(app.repo.root, REPOSITORY_CONFIG_PATH), serializeRepositoryConfig({
        schemaVersion: REPOSITORY_CONFIG_SCHEMA_VERSION,
        baseBranch: "main",
        harness: "none",
        github,
      }), "utf8");
    };

    await write({
      refs: { enabled: true },
      issue: { enabled: false, classification: defaultIssueClassification() },
      milestone: { enabled: false },
      project: { mode: "disabled" },
    });
    assert.deepEqual(await readProjections(app.repo.root), { refs: true, issue: false, milestone: false, project: false });

    await write({
      refs: { enabled: false },
      issue: { enabled: true, classification: defaultIssueClassification() },
      milestone: { enabled: true },
      project: { mode: "managed" },
    });
    assert.deepEqual(await readProjections(app.repo.root), { refs: false, issue: true, milestone: true, project: true });
  } finally {
    await app.cleanup();
  }
});

test("reads the Issue classification from the repository configuration", async () => {
  const app = await createTestApp();
  try {
    const classification = { mode: "labels" as const, labels: { Bug: "kind/defect", Feature: "kind/feature", Task: "kind/task" } };
    await mkdir(path.join(app.repo.root, ".codepatrol"), { recursive: true });
    await writeFile(path.join(app.repo.root, REPOSITORY_CONFIG_PATH), serializeRepositoryConfig({
      schemaVersion: REPOSITORY_CONFIG_SCHEMA_VERSION,
      baseBranch: "main",
      harness: "none",
      github: {
        refs: { enabled: true },
        issue: { enabled: true, classification },
        milestone: { enabled: false },
        project: { mode: "disabled" },
      },
    }), "utf8");

    const settings = await readPublicationSettings(app.repo.root);
    assert.deepEqual(settings.classification, classification);
    assert.deepEqual(settings.projections, { refs: true, issue: true, milestone: false, project: false });
  } finally {
    await app.cleanup();
  }
});

test("an unconfigured workspace falls back to the default Issue classification", async () => {
  const app = await createTestApp();
  try {
    assert.deepEqual((await readPublicationSettings(app.repo.root)).classification, defaultIssueClassification());
  } finally {
    await app.cleanup();
  }
});

test("the board shows the stage of a live run, not the stage the Work is ready for", async () => {
  // A live run is the activity the board should report. Starting a Review run
  // moves the status to Review as soon as the run opens, before it completes.
  const app = await createTestApp({ remoteRepository: REPOSITORY });
  try {
    const workId = await app.createWork({ title: "Live run" });
    await app.runStage("plan", workId);
    await app.publication.reconcile({ repository: REPOSITORY, remote: "origin", workId });
    const lastReconcileStatus = (): string => {
      const calls = app.github.calls.filter((call) => call.op === "reconcile");
      return (calls.at(-1)?.args as { status: string }).status;
    };
    assert.equal(lastReconcileStatus(), "Plan", "after a Plan run completes the board sits at Plan while the Work waits");

    const started = await app.works.start("review", workId, "test-harness", "test-model", TODO);
    const result = await app.publication.reconcile({ repository: REPOSITORY, remote: "origin", workId });
    assert.deepEqual(result.project.statuses, [{ workId, status: "Review", outcome: "None" }], "the board moves to Review as soon as the run starts");
    assert.equal(lastReconcileStatus(), "Review");

    await app.works.complete("review", workId, started.runId, {
      decision: "continue",
      summary: "review continues",
      handoff: "next",
      todo: DONE_TODO,
      artifacts: [],
    });
  } finally {
    await app.cleanup();
  }
});

test("a terminal Work projects Done and a repeated sync with no new run does not move the status", async () => {
  // Status changes are reconciliation, not free-form state: once a Work is
  // terminal its Project status is Done, and a sync with no new run writes
  // the same value back, so the board value never moves.
  const app = await createTestApp({ remoteRepository: REPOSITORY });
  try {
    const workId = await app.createWork({ title: "Terminal stability" });
    await app.runThrough(workId);
    await app.publication.reconcile({ repository: REPOSITORY, remote: "origin", workId });
    const lastReconcileArgs = (): { issue: number; status: string; outcome: string } => {
      const calls = app.github.calls.filter((call) => call.op === "reconcile");
      return calls.at(-1)?.args as { issue: number; status: string; outcome: string };
    };
    assert.deepEqual(lastReconcileArgs(), { issue: 1, status: "Done", outcome: "Accepted" }, "the terminal status is Done");

    const result = await app.publication.reconcile({ repository: REPOSITORY, remote: "origin", workId });
    assert.deepEqual(result.project.statuses, [{ workId, status: "Done", outcome: "Accepted" }], "the derived status is unchanged");
    assert.deepEqual(lastReconcileArgs(), { issue: 1, status: "Done", outcome: "Accepted" }, "the second sync writes the same status back, so the board value does not move");
  } finally {
    await app.cleanup();
  }
});
