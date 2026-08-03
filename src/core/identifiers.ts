/** A Work id names its home: `INIT-<n>.<p>-<slug>` — Initiative, position, slug. */
export const WORK_ID = /^INIT-\d+\.\d+-[a-z0-9][a-z0-9-]*$/;
/** A Work's short code: `INIT-<n>.<p>` — the handle a reader can name, scan, and sort by. */
export const WORK_CODE = /^INIT-\d+\.\d+$/;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const GIT_HASH = /^[0-9a-f]{40,64}$/;
/** A skill id: the directory name under skills/, e.g. `codepatrol-build`. */
export const SKILL_ID = /^[a-z0-9][a-z0-9-]*$/;
/** A trace's stable handle, short enough to read inside an evidence reference. */
export const TRACE_ID = /^[0-9a-f]{12}$/;
/** A branch ref. Deliberately not pinned to `main`: the base is per repository. */
export const BRANCH_REF = /^refs\/heads\/(?!.*\.\.)(?!.*\/\/)(?!.*\.lock(?:\/|$))[^\x00-\x20~^:?*[\\/][^\x00-\x20~^:?*[\\]*(?<![./])$/;

/** The short code a Work carries, `INIT-<n>.<p>`, derived from a full Work id. */
export function workCodeOf(workId: string): string {
  const match = WORK_ID.exec(workId);
  if (match === null) throw new Error(`Not a Work id: ${workId}.`);
  return match[0].replace(/-[a-z0-9][a-z0-9-]*$/, "");
}
