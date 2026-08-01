import { CodepatrolError } from "../../core/errors.js";
import type { WorkManifest } from "../../core/work-manifest.js";
import type { GitHubIssue } from "../ports.js";
import { issueRequester, markedWorkIds, trustedAssociation } from "./markers.js";

/**
 * Three independent signals can associate an Issue with a Work: a hidden marker
 * in its body, the `issue` link stored in a manifest, and the `requestedBy`
 * identity of a Work that originated from that Issue.
 *
 * They must agree. A disagreement means either a human edited a marker or two
 * Works are competing for the same Issue, and guessing which signal wins would
 * silently rewrite the wrong Work — so every conflict is refused instead.
 */
export interface WorkIndex {
  byIssue: Map<number, WorkManifest>;
  byRequester: Map<string, WorkManifest>;
  byId: Map<string, WorkManifest>;
}

export function indexWorks(entries: readonly WorkManifest[], repository: string): WorkIndex {
  const byIssue = new Map<number, WorkManifest>();
  const byRequester = new Map<string, WorkManifest>();
  const byId = new Map(entries.map((entry) => [entry.work.id, entry]));
  for (const entry of entries) {
    if (entry.issue?.repository === repository) {
      if (byIssue.has(entry.issue.number)) throw new CodepatrolError("SYNC_CONFLICT", `Multiple Works map to Issue #${entry.issue.number}.`);
      byIssue.set(entry.issue.number, entry);
    }
    if (entry.work.requestedBy.startsWith(`github:${repository}#`)) {
      if (byRequester.has(entry.work.requestedBy)) throw new CodepatrolError("SYNC_CONFLICT", `Multiple Works map to ${entry.work.requestedBy}.`);
      byRequester.set(entry.work.requestedBy, entry);
    }
  }
  return { byIssue, byRequester, byId };
}

export interface IssueMatch {
  /** The Work this Issue belongs to, or undefined when it belongs to none yet. */
  entry: WorkManifest | undefined;
  /** Whether any signal named `selectedWorkId`; meaningless when unscoped. */
  concernsSelected: boolean;
}

export function matchIssue(
  issue: GitHubIssue,
  index: WorkIndex,
  repository: string,
  viewer: string,
  selectedWorkId?: string,
): IssueMatch {
  // A marker only claims a Work when whoever wrote it is entitled to; otherwise
  // any outside commenter could redirect publication at an unrelated Work.
  const trusted = issue.author.toLowerCase() === viewer.toLowerCase() || trustedAssociation(issue.authorAssociation)
    ? [...new Set(markedWorkIds(issue.body))]
    : [];
  const requester = issueRequester(repository, issue.number);
  const requestedEntry = index.byRequester.get(requester);
  const linkedEntry = index.byIssue.get(issue.number);

  const markedEntries = trusted.map((id) => index.byId.get(id)).filter((entry): entry is WorkManifest => entry !== undefined);
  if (markedEntries.length > 1) throw new CodepatrolError("SYNC_CONFLICT", `Issue #${issue.number} maps to multiple Works.`);
  const markedEntry = markedEntries[0];
  if (markedEntry !== undefined && requestedEntry !== undefined && markedEntry.work.id !== requestedEntry.work.id) {
    throw new CodepatrolError("SYNC_CONFLICT", `Issue #${issue.number} has conflicting marker and requester mappings.`);
  }
  const candidates = new Set([markedEntry, linkedEntry, requestedEntry]
    .filter((candidate): candidate is WorkManifest => candidate !== undefined)
    .map((candidate) => candidate.work.id));
  if (candidates.size > 1) throw new CodepatrolError("SYNC_CONFLICT", `Issue #${issue.number} has conflicting Work mappings.`);

  return {
    entry: markedEntry ?? linkedEntry ?? requestedEntry,
    concernsSelected: selectedWorkId !== undefined && (
      trusted.includes(selectedWorkId)
      || linkedEntry?.work.id === selectedWorkId
      || requestedEntry?.work.id === selectedWorkId
    ),
  };
}
