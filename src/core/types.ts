export const STAGES = ["plan", "review", "build", "verify", "ship"] as const;
export type Stage = (typeof STAGES)[number];

export const STAGE_ROLES: Readonly<Record<Stage, string>> = {
  plan: "planner",
  review: "reviewer",
  build: "builder",
  verify: "verifier",
  ship: "shipper",
};

export const PROJECT_STATUSES = ["Backlog", "Plan", "Review", "Build", "Verify", "Ship", "Done"] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const PROJECT_OUTCOMES = ["None", "Accepted", "Rolled back", "Superseded", "Cancelled"] as const;
export type ProjectOutcome = (typeof PROJECT_OUTCOMES)[number];

export const PROJECT_STATUS_BY_STAGE: Readonly<Record<Stage, ProjectStatus>> = {
  plan: "Plan",
  review: "Review",
  build: "Build",
  verify: "Verify",
  ship: "Ship",
};

export const PROJECT_OUTCOME_BY_WORK_OUTCOME: Readonly<Record<WorkOutcome, ProjectOutcome>> = {
  "accepted": "Accepted",
  "rolled-back": "Rolled back",
  "superseded": "Superseded",
  "cancelled": "Cancelled",
};

export const ISSUE_TYPES = ["Bug", "Feature", "Task"] as const;
export type IssueType = (typeof ISSUE_TYPES)[number];

export const WORK_PRIORITIES = ["p0", "p1", "p2", "p3"] as const;
export type WorkPriority = (typeof WORK_PRIORITIES)[number];

/**
 * How a Work ended.
 *
 * `accepted` and `rolled-back` are Ship's two decisions. `superseded` and
 * `cancelled` are graph decisions applied by Spec: a superseded Work was
 * replaced, a cancelled one was abandoned on authority. Neither is a Ship
 * outcome, and neither releases a dependent — only `accepted` does.
 */
export const WORK_OUTCOMES = ["accepted", "rolled-back", "superseded", "cancelled"] as const;
export type WorkOutcome = (typeof WORK_OUTCOMES)[number];

/** The outcomes Ship itself may decide. */
export const SHIP_OUTCOMES = ["accepted", "rolled-back"] as const;
export type ShipOutcome = (typeof SHIP_OUTCOMES)[number];

export const NEXT_STEPS = [...STAGES, "done"] as const;
export type NextStep = (typeof NEXT_STEPS)[number];

export function nextStepOf(work: { completion: unknown | null; workflow: { stage: Stage } }): NextStep {
  if (work.completion !== null) return "done";
  return work.workflow.stage;
}

export const RETURN_TARGETS: Readonly<Partial<Record<Stage, readonly Stage[]>>> = {
  review: ["plan"],
  build: ["plan"],
  verify: ["build", "plan"],
};

export interface RepositoryCommit {
  hash: string;
  author: string;
  authoredAt: string;
  subject: string;
}

export interface RepositoryInspection {
  /** Null while the Work has no branch: a backlog Work has no baseline yet. */
  createdFromCommit: string | null;
  baselineCommit: string | null;
  headCommit: string | null;
  targetCommit: string;
  baselineStale: boolean;
  clean: boolean;
  status: string[];
  commits: RepositoryCommit[];
  changedFiles: string[];
  diffStat: string;
}

/**
 * Where a Work came from.
 *
 * Spec is not an entity and the raw user prompt is not canonical state, so all
 * a Work can name is when it was created and, for a follow-up, what it came
 * out of. An Initiative motivated it — that reasoning lives in the Initiative
 * document, in prose, not duplicated here as structured provenance.
 */
export interface WorkOrigin {
  createdAt: string;
  /** Work that explicitly produced this follow-up, when applicable. */
  followUpOf?: string;
}

/**
 * The Initiative a Work belongs to. Part of the identity: the id already names
 * it (`INIT-<n>.<p>-<slug>`), and the recorded fields let a reader get the
 * membership without parsing the identifier.
 */
export interface WorkInitiative {
  id: string;
  position: number;
}

export interface WorkIdentity {
  id: string;
  title: string;
  description: string;
  issueType: IssueType;
  priority: WorkPriority;
  /**
    * What must be demonstrably true for this Work to be accepted.
    *
    * Verify reports an outcome per criterion, so these are the contract Ship
    * checks against — not a restatement of the description.
    */
  acceptance: string[];
  createdAt: string;
  requestedBy: string;
  initiative: WorkInitiative;
  origin: WorkOrigin;
}

export interface ExecutionIdentity {
  role: string;
  harness: string;
  model: string;
}

export interface TodoItem {
  id: string;
  title: string;
  description?: string;
}

export const TODO_STATUSES = ["completed", "skipped", "failed"] as const;
export type TodoStatus = (typeof TODO_STATUSES)[number];

export interface TodoResult {
  id: string;
  status: TodoStatus;
  note?: string;
}

/**
 * Whether a set of todo outcomes can support a given decision.
 *
 * A decision that carries the work forward — `continue` or `accept` — cannot
 * rest on an item that was evaluated and not satisfied; that is what `return`
 * and `rollback` are for. A deliberately skipped item still owes a reason,
 * because "not applicable" is a claim.
 */
export function todoContractViolations(decision: "continue" | "return" | "accept" | "rollback", todo: readonly TodoResult[]): string[] {
  const problems: string[] = [];
  const skippedWithoutReason = todo.filter((item) => item.status === "skipped" && (item.note ?? "").trim() === "");
  if (skippedWithoutReason.length > 0) {
    problems.push(`skipped without a justification: ${skippedWithoutReason.map((item) => item.id).join(", ")}`);
  }
  if (decision === "continue" || decision === "accept") {
    const failed = todo.filter((item) => item.status === "failed");
    if (failed.length > 0) {
      problems.push(`${decision} cannot carry failed items: ${failed.map((item) => item.id).join(", ")}`);
    }
  }
  return problems;
}

/**
 * What became of one attempt.
 *
 * `abandoned` is the only non-active status without a result: the attempt was
 * still running when Spec terminated the Work. Its evidence is preserved, but
 * it never concluded, so it must not be read as one.
 */
export const ATTEMPT_STATUSES = ["active", "completed", "returned", "invalidated", "abandoned"] as const;
export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];

/** Where a Work stands in the graph, derived rather than stored. */
export const WORK_STATUSES = ["blocked", "executable", "active", "accepted", "rolled-back", "superseded", "cancelled"] as const;
export type WorkStatus = (typeof WORK_STATUSES)[number];
