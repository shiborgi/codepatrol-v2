import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { CodepatrolError } from "../core/errors.js";
import { prettyJson } from "../core/json.js";

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface LockOwner {
  token: string;
  pid: number;
  hostname: string;
  createdAt: string;
}

/**
 * Locks may only be acquired in this order. Every nested acquisition must move
 * strictly down the list, which makes a deadlock between two processes
 * impossible: nobody can hold a later lock while waiting for an earlier one.
 *
 * - `sync` serializes publication within a checkout.
 * - `work/<id>` serializes one Work's own state. Two Works never contend.
 * - `repository` serializes shared Git state: the worktree registry and the
 *   base branch ref.
 */
/** Acquisition deadline. Generous enough for a ship that merges a large tree. */
const ACQUIRE_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 25;
// Foreign-host locks are never stolen from timing alone; an operator must
// establish that the owner is gone before deleting such a ref.

const HELD = new AsyncLocalStorage<ReadonlySet<string>>();
/** Locks this process currently owns, so a signal can release them. */
const OWNED = new Map<string, { workspace: string; lockRef: string; ownerHash: string }>();
let signalsRegistered = false;

function rankOf(key: string): number {
  if (key === "sync") return 0;
  if (/^work\/INIT-\d+\.\d+-[a-z0-9][a-z0-9-]*$/.test(key)) return 1;
  if (key === "repository") return 2;
  throw new CodepatrolError("INVALID_INPUT", `Unknown lock key: ${key}.`);
}

async function git(workspace: string, args: string[], input?: string): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const hooksPath = process.platform === "win32" ? "NUL" : "/dev/null";
    const child = spawn("git", ["-c", `core.hooksPath=${hooksPath}`, ...args], { cwd: workspace, stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }));
    child.stdin.end(input);
  });
}

function recoverable(raw: string): boolean {
  try {
    const owner = JSON.parse(raw) as Partial<LockOwner>;
    if (owner.hostname === hostname() && typeof owner.pid === "number") {
      try {
        process.kill(owner.pid, 0);
        return false;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ESRCH";
      }
    }
    return false;
  } catch {
    return true;
  }
}

/**
 * Releases every lock this process owns. The delete is a compare-and-swap on
 * the owner hash, so a lock already reclaimed by someone else is left alone.
 */
async function releaseOwned(): Promise<void> {
  const owned = [...OWNED.values()];
  OWNED.clear();
  await Promise.all(owned.map((lock) => git(lock.workspace, ["update-ref", "-d", lock.lockRef, lock.ownerHash]).catch(() => undefined)));
}

function registerSignals(): void {
  if (signalsRegistered) return;
  signalsRegistered = true;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      // Without this a Ctrl-C strands the ref until the staleness heuristic expires.
      void releaseOwned().finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
    });
  }
}

/**
 * Runs `operation` while holding `refs/codepatrol/locks/<key>`.
 *
 * Re-entering a lock this async context already holds is a pass-through, not an
 * error: an operation that legitimately nests can call the locked helper
 * directly instead of maintaining a second, lock-free copy of it.
 */
export async function withGitRefLock<T>(workspace: string, key: string, operation: () => Promise<T>): Promise<T> {
  const lockPath = `${workspace}:${key}`;
  const held = HELD.getStore() ?? new Set<string>();
  if (held.has(lockPath)) return operation();

  const rank = rankOf(key);
  for (const heldPath of held) {
    const heldRank = rankOf(heldPath.slice(heldPath.indexOf(":") + 1));
    if (heldRank >= rank) {
      throw new CodepatrolError("LOCK_ORDER", `Cannot acquire ${key} while holding ${heldPath.slice(heldPath.indexOf(":") + 1)}; locks are ordered sync, work, repository.`);
    }
  }

  const lockRef = `refs/codepatrol/locks/${key}`;
  const owner: LockOwner = { token: randomUUID(), pid: process.pid, hostname: hostname(), createdAt: new Date().toISOString() };
  const object = await git(workspace, ["hash-object", "-w", "--stdin"], prettyJson(owner));
  if (object.code !== 0) throw new CodepatrolError("GIT_ERROR", object.stderr.trim() || "Could not create the lock owner object.");
  const ownerHash = object.stdout.trim();
  const zeroHash = "0".repeat(ownerHash.length);
  const deadline = Date.now() + ACQUIRE_TIMEOUT_MS;

  while (true) {
    const acquired = await git(workspace, ["update-ref", lockRef, ownerHash, zeroHash]);
    if (acquired.code === 0) break;
    const current = await git(workspace, ["rev-parse", "--verify", lockRef]);
    if (current.code !== 0) continue;
    const currentHash = current.stdout.trim();
    const rawOwner = await git(workspace, ["cat-file", "blob", currentHash]);
    if (rawOwner.code !== 0 || recoverable(rawOwner.stdout)) {
      const removed = await git(workspace, ["update-ref", "-d", lockRef, currentHash]);
      if (removed.code === 0) continue;
    }
    if (Date.now() >= deadline) throw new CodepatrolError("GIT_LOCKED", `Lock ${key} is held by another process.`);
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  registerSignals();
  OWNED.set(lockPath, { workspace, lockRef, ownerHash });
  try {
    return await HELD.run(new Set([...held, lockPath]), operation);
  } finally {
    OWNED.delete(lockPath);
    await git(workspace, ["update-ref", "-d", lockRef, ownerHash]);
  }
}
