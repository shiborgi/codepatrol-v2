import assert from "node:assert/strict";
import test from "node:test";
import { CodepatrolError } from "../core/errors.js";
import { parseRepositoryConfig, serializeRepositoryConfig } from "../core/repository-config.js";
import { defaultIssueClassification, DEFAULT_WORK_TYPE_LABELS, isManagedWorkTypeLabel, resolveWorkTypeLabel, WORK_TYPE_LABEL_NAMESPACE } from "../core/work-type-labels.js";

function configDocument(issue: Record<string, unknown>): string {
  return JSON.stringify({
    schemaVersion: 1,
    baseBranch: "main",
    harness: "none",
    github: {
      refs: { enabled: true },
      issue,
      project: { mode: "disabled" },
    },
  });
}

test("resolves every Work type to its deterministic managed label", () => {
  const classification = defaultIssueClassification();
  assert.deepEqual(resolveWorkTypeLabel("Bug", classification), DEFAULT_WORK_TYPE_LABELS.Bug);
  assert.deepEqual(resolveWorkTypeLabel("Feature", classification), DEFAULT_WORK_TYPE_LABELS.Feature);
  assert.deepEqual(resolveWorkTypeLabel("Task", classification), DEFAULT_WORK_TYPE_LABELS.Task);

  const custom = { mode: "labels", labels: { Bug: "codepatrol:type/defect", Feature: "codepatrol:type/feature", Task: "codepatrol:type/task" } } as const;
  const resolved = resolveWorkTypeLabel("Bug", custom);
  assert.equal(resolved.name, "codepatrol:type/defect");
  assert.equal(resolved.description, DEFAULT_WORK_TYPE_LABELS.Bug.description, "metadata stays deterministic under custom names");
});

test("detects managed labels without claiming user labels", () => {
  const classification = defaultIssueClassification();
  assert.equal(isManagedWorkTypeLabel("codepatrol:type/bug", classification), true);
  assert.equal(isManagedWorkTypeLabel(`${WORK_TYPE_LABEL_NAMESPACE}legacy`, classification), true, "the namespace is managed for migration");
  assert.equal(isManagedWorkTypeLabel("bug", classification), false);
  assert.equal(isManagedWorkTypeLabel("enhancement", classification), false);
  assert.equal(isManagedWorkTypeLabel("security", classification), false);
});

test("defaults classification when the configuration predates it", () => {
  const config = parseRepositoryConfig(configDocument({ enabled: true }));
  assert.deepEqual(config.github.issue.classification, defaultIssueClassification());
  assert.deepEqual(parseRepositoryConfig(serializeRepositoryConfig(config)).github.issue.classification, config.github.issue.classification, "round-trip is stable");
});

test("accepts a complete custom classification", () => {
  const config = parseRepositoryConfig(configDocument({
    enabled: true,
    classification: { mode: "labels", labels: { Bug: "codepatrol:type/defect", Feature: "codepatrol:type/feature", Task: "codepatrol:type/task" } },
  }));
  assert.equal(config.github.issue.classification.labels.Bug, "codepatrol:type/defect");
});

test("rejects partial, empty, duplicated, and unknown classification values", () => {
  const rejects = (issue: Record<string, unknown>, fragment: string) => {
    assert.throws(
      () => parseRepositoryConfig(configDocument(issue)),
      (error: unknown) => error instanceof CodepatrolError && error.code === "INVALID_CONFIG" && error.message.includes(fragment),
    );
  };
  rejects({ enabled: true, classification: { mode: "labels", labels: { Bug: "codepatrol:type/bug", Feature: "codepatrol:type/feature" } } }, "is missing Task");
  rejects({ enabled: true, classification: { mode: "labels", labels: { Bug: "", Feature: "codepatrol:type/feature", Task: "codepatrol:type/task" } } }, "non-empty strings");
  rejects({ enabled: true, classification: { mode: "labels", labels: { Bug: "codepatrol:type/shared", Feature: "codepatrol:type/shared", Task: "codepatrol:type/task" } } }, "more than one work type");
  rejects({ enabled: true, classification: { mode: "labels", labels: { Bug: "codepatrol:type/bug", Feature: "codepatrol:type/feature", Task: "codepatrol:type/task", Chore: "codepatrol:type/chore" } } }, "unknown work type");
  rejects({ enabled: true, classification: { mode: "native", labels: { Bug: "codepatrol:type/bug", Feature: "codepatrol:type/feature", Task: "codepatrol:type/task" } } }, "mode must be labels");
  rejects({ enabled: true, classification: { mode: "labels", labels: { Bug: "codepatrol:type/bug", Feature: "codepatrol:type/feature", Task: "codepatrol:type/task" }, strict: true } }, "unknown field");
});
