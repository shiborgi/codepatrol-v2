const WORK_MARKER = /^<!-- codepatrol-work-id: ([^\s]+) -->$/;
const WORK_SECTION = /<!-- codepatrol:work:start -->[\s\S]*?<!-- codepatrol:work:end -->/;
const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

/**
 * The hidden marker that ties an Issue back to its Work.
 *
 * Markers are read only from fenced-code-free lines, because an Issue body can
 * legitimately quote a marker inside a code block — as this repository's own
 * documentation does — and that quote must not claim the Work.
 */
export function marker(workId: string): string {
  return `<!-- codepatrol-work-id: ${workId} -->`;
}

function withoutFences(body: string, onLine: (line: string) => void): void {
  let fence: "```" | "~~~" | undefined;
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trimStart();
    if (fence === undefined && (trimmed.startsWith("```") || trimmed.startsWith("~~~"))) {
      fence = trimmed.startsWith("```") ? "```" : "~~~";
      continue;
    }
    if (fence !== undefined) {
      if (trimmed.startsWith(fence)) fence = undefined;
      continue;
    }
    onLine(line);
  }
}

/** Replaces any unfenced marker with exactly one for `workId`, at the end. */
export function addMarker(body: string, workId: string): string {
  const lines = body.split(/\r?\n/);
  let fence: "```" | "~~~" | undefined;
  const retained = lines.filter((line) => {
    const trimmed = line.trimStart();
    if (fence === undefined && (trimmed.startsWith("```") || trimmed.startsWith("~~~"))) fence = trimmed.startsWith("```") ? "```" : "~~~";
    else if (fence !== undefined && trimmed.startsWith(fence)) fence = undefined;
    return fence !== undefined || !WORK_MARKER.test(line);
  });
  const trimmed = retained.join("\n").trimEnd();
  return `${trimmed}${trimmed === "" ? "" : "\n\n"}${marker(workId)}\n`;
}

export function markedWorkIds(body: string): string[] {
  const ids: string[] = [];
  withoutFences(body, (line) => {
    const match = WORK_MARKER.exec(line);
    if (match?.[1] !== undefined) ids.push(match[1]);
  });
  return ids;
}

export interface ManagedWorkDetails {
  workId: string;
  issueType: string;
  priority: string;
  stage: string;
}

export function managedWorkSection(details: ManagedWorkDetails): string {
  return [
    "<!-- codepatrol:work:start -->",
    "",
    "## CodePatrol Work",
    "",
    `- Work: \`${details.workId}\``,
    `- Type: \`${details.issueType}\``,
    `- Priority: \`${details.priority}\``,
    `- Stage: \`${details.stage}\``,
    "",
    "<!-- codepatrol:work:end -->",
  ].join("\n");
}

/**
 * The visible classification fallback: even when label projection is
 * unavailable, the managed section keeps the Work type readable on the Issue.
 * The section is a projection — replaced in place, never authoritative.
 */
export function setManagedWorkSection(body: string, details: ManagedWorkDetails): string {
  const section = managedWorkSection(details);
  if (WORK_SECTION.test(body)) return body.replace(WORK_SECTION, section);
  const trimmed = body.trimEnd();
  return `${trimmed}${trimmed === "" ? "" : "\n\n"}${section}\n`;
}

const INITIATIVE_SECTION = /<!-- codepatrol:initiative:start -->[\s\S]*?<!-- codepatrol:initiative:end -->/;

export interface InitiativeSectionDetails {
  title: string;
  intent: string;
  motivation: string;
  ordering: string;
  works: Array<{ id: string; title: string }>;
}

export function initiativeSection(details: InitiativeSectionDetails): string {
  return [
    "<!-- codepatrol:initiative:start -->",
    "",
    `## ${details.title}`,
    "",
    `**Intent:** ${details.intent}  `,
    `**Motivation:** ${details.motivation}  `,
    `**Ordering:** ${details.ordering}`,
    "",
    ...details.works.map((work) => `- \`${work.id}\` ${work.title}`),
    "",
    "<!-- codepatrol:initiative:end -->",
  ].join("\n");
}

/** Replaces the managed Initiative section, preserving human text outside it. */
export function setInitiativeSection(description: string, section: string): string {
  if (INITIATIVE_SECTION.test(description)) return description.replace(INITIATIVE_SECTION, section);
  const trimmed = description.trimEnd();
  return `${trimmed}${trimmed === "" ? "" : "\n\n"}${section}`;
}

/** Whether a marker written by this author may be trusted to claim a Work. */
export function trustedAssociation(value: string | undefined): boolean {
  return value !== undefined && TRUSTED_ASSOCIATIONS.has(value.toUpperCase());
}

/** The `requestedBy` identity recorded for a Work that originated in an Issue. */
export function issueRequester(repository: string, issueNumber: number): string {
  return `github:${repository}#${issueNumber}`;
}
