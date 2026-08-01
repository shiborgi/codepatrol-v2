/** A Work id names its home: `INIT-<n>.<p>-<slug>` — Initiative, position, slug. */
export const WORK_ID = /^INIT-\d+\.\d+-[a-z0-9][a-z0-9-]*$/;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const GIT_HASH = /^[0-9a-f]{40,64}$/;
/** A trace's stable handle, short enough to read inside an evidence reference. */
export const TRACE_ID = /^[0-9a-f]{12}$/;
/** A branch ref. Deliberately not pinned to `main`: the base is per repository. */
export const BRANCH_REF = /^refs\/heads\/(?!.*\.\.)(?!.*\/\/)(?!.*\.lock(?:\/|$))[^\x00-\x20~^:?*[\\/][^\x00-\x20~^:?*[\\]*(?<![./])$/;
