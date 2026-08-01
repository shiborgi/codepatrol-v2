import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { GitPort } from "./ports.js";
import type { Worktrees } from "../adapters/worktree.js";
import { CodepatrolError } from "../core/errors.js";
import { workBranchRef, type ManifestTrace, type VerificationSnapshot, type WorkManifest } from "../core/work-manifest.js";
import { boundedTail, outputEvidence, redact } from "../core/redaction.js";
import { parseVerifyPolicy, renderCommand, unsatisfiedCommands, verifyPolicyHash, VERIFY_POLICY_PATH, type VerifyPolicy } from "../core/verify-policy.js";
import type { Clock, TraceInput } from "./work-service.js";

export interface VerifyEvidenceContext {
  workId: string;
  runId: string;
  attempt: number;
  candidateCommit: string;
  policyHash: string;
}

/**
 * The Verify domain boundary: policy lookup, native command execution, evidence
 * binding, and the freshness checks that make a verification stand or fall.
 */
export class VerificationGate {
  constructor(
    private readonly git: GitPort,
    private readonly worktrees: Worktrees,
    private readonly clock: Clock,
    private readonly recordTrace: (entry: TraceInput) => Promise<unknown>,
    private readonly workspace: string,
  ) {}

  async policyAt(commit: string): Promise<{ policy: VerifyPolicy; hash: string }> {
    const raw = await this.git.readPath(commit, VERIFY_POLICY_PATH);
    if (raw === undefined) {
      throw new CodepatrolError("VERIFY_POLICY_REQUIRED", `${VERIFY_POLICY_PATH} is required before Verify can start.`, 1, {
        expected: `${VERIFY_POLICY_PATH} with at least one required command`,
        observed: "the policy file is absent from the candidate",
        nextCommand: "codepatrol init",
      });
    }
    const policy = parseVerifyPolicy(raw);
    return { policy, hash: verifyPolicyHash(policy) };
  }

  async pinTarget(manifest: WorkManifest, candidateCommit: string, manifestCommit: string, attempt: number): Promise<VerificationSnapshot> {
    const baselineCommit = manifest.repository.baselineCommit;
    if (baselineCommit === undefined) throw new CodepatrolError("INVALID_TRANSITION", `Verify requires a materialized Change branch: ${manifest.work.id}.`);
    const targetCommit = await this.git.resolveCommit(manifest.repository.baseRef);
    const { hash } = await this.policyAt(candidateCommit);
    return {
      attempt,
      candidateCommit,
      manifestCommit,
      baselineCommit,
      targetCommit,
      policyHash: hash,
    };
  }

  private async execute(directory: string, command: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const [executable, ...args] = command;
    if (executable === undefined) throw new CodepatrolError("INVALID_POLICY", "A Verify command may not be empty.");
    return new Promise((resolve, reject) => {
      const child = spawn(executable, args, { cwd: directory, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.on("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") {
          resolve({ exitCode: 127, stdout: "", stderr: error.message });
          return;
        }
        reject(error);
      });
      child.on("close", (code) => resolve({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      }));
    });
  }

  /**
   * Keeps the untouched output where an operator can read it during the run.
   *
   * `.codepatrol/runtime/` is excluded from Git and cleared on the next start,
   * so this is diagnosis, never a record. The record is the digest in the
   * manifest, which identifies these exact bytes without carrying them.
   */
  private async persistOutput(
    context: VerifyEvidenceContext,
    index: number,
    command: readonly string[],
    result: { exitCode: number; stdout: string; stderr: string },
  ): Promise<string> {
    const directory = path.join(this.workspace, ".codepatrol", "runtime", "works", context.workId, "current", "verify");
    await mkdir(directory, { recursive: true });
    const file = path.join(directory, `${String(index + 1).padStart(2, "0")}.log`);
    await writeFile(file, [
      `# ${renderCommand([...command])}`,
      `# exit ${result.exitCode}`,
      "",
      "## stdout",
      result.stdout,
      "## stderr",
      result.stderr,
      "",
    ].join("\n"), "utf8");
    return path.relative(this.workspace, file);
  }

  async runRequiredCommands(context: VerifyEvidenceContext, pinned: VerificationSnapshot, currentPolicyHash: string): Promise<void> {
    if (currentPolicyHash !== pinned.policyHash) throw new CodepatrolError("VERIFY_STALE", `${VERIFY_POLICY_PATH} changed during Verify; start Verify again.`);
    const directory = await this.worktrees.find(workBranchRef(context.workId));
    if (directory === undefined) throw new CodepatrolError("GIT_WORKTREE", `Verify worktree is unavailable for ${context.workId}; resume Verify first.`);
    const { policy } = await this.policyAt(pinned.candidateCommit);
    for (const [index, command] of policy.requiredCommands.entries()) {
      const startedAt = this.clock.now().toISOString();
      const result = await this.execute(directory, command);
      const finishedAt = this.clock.now().toISOString();
      // The full output is written to the disposable runtime, and only a
      // bounded, redacted excerpt plus a digest reaches the manifest. The
      // manifest is committed and pushed; raw build output must not be.
      const logPath = await this.persistOutput(context, index, command, result);
      await this.recordTrace({
        type: "command",
        message: `${redact(renderCommand(command)).text} exited with ${result.exitCode}`,
        command,
        exitCode: result.exitCode,
        data: {
          source: "codepatrol",
          workId: context.workId,
          runId: context.runId,
          attempt: context.attempt,
          candidateCommit: context.candidateCommit,
          policyHash: context.policyHash,
          startedAt,
          finishedAt,
          stdout: outputEvidence(result.stdout, { excerpt: policy.persistOutputExcerpt }),
          stderr: outputEvidence(result.stderr, { excerpt: policy.persistOutputExcerpt }),
          outputLog: logPath,
        },
      });
      if (result.exitCode !== 0) {
        const detail = redact(boundedTail(result.stderr, 400).text.trim() || boundedTail(result.stdout, 400).text.trim()).text;
        throw new CodepatrolError("VERIFY_COMMAND_FAILED", `Verify command failed (${result.exitCode}): ${renderCommand(command)}.`, 1, {
          expected: "every configured Verify command to exit successfully",
          observed: detail || `exit code ${result.exitCode}`,
          committed: [`the Verify attempt remains active as run ${context.runId}`, `full output: ${logPath}`],
          nextCommand: `codepatrol verify complete ${context.workId} --run ${context.runId} --result <result.json>`,
        });
      }
    }
  }

  assertEvidence(context: VerifyEvidenceContext, pinned: VerificationSnapshot, policy: VerifyPolicy, traces: readonly ManifestTrace[]): void {
    const bound = traces.filter((trace) => trace.data?.source === "codepatrol"
      && trace.data.workId === context.workId
      && trace.data.runId === context.runId
      && trace.data.attempt === pinned.attempt
      && trace.data.candidateCommit === pinned.candidateCommit
      && trace.data.policyHash === pinned.policyHash);
    const missing = unsatisfiedCommands(policy, bound);
    if (missing.length > 0) {
      throw new CodepatrolError("VERIFY_INCOMPLETE", `Verify requires a fresh successful run of: ${missing.map(renderCommand).map((command) => `\`${command}\``).join(", ")}.`, 1, {
        expected: `a successful trace for each of: ${missing.map(renderCommand).join("; ")}`,
        observed: `${traces.filter((trace) => trace.type === "command").length} command trace(s) in this run, none matching`,
        committed: [`the Verify attempt is recorded and still active as run ${context.runId}`],
        nextCommand: `codepatrol verify complete ${context.workId} --run ${context.runId} --result <result.json>`,
      });
    }
  }

  async assertCandidateFresh(pinned: VerificationSnapshot, manifest: WorkManifest, currentCommit: string, targetCommit: string, movedSince: (candidate: string, head: string) => Promise<string[]>): Promise<void> {
    if (pinned.baselineCommit !== manifest.repository.baselineCommit || pinned.targetCommit !== targetCommit) {
      throw new CodepatrolError("VERIFY_STALE", "The base or baseline moved during Verify.", 1, {
        expected: `base ${pinned.targetCommit} and baseline ${pinned.baselineCommit}`,
        observed: `base ${targetCommit} and baseline ${manifest.repository.baselineCommit}`,
        committed: ["the Verify attempt is recorded and still active"],
        nextCommand: `codepatrol change refresh ${manifest.work.id}`,
      });
    }
    const moved = await movedSince(pinned.candidateCommit, currentCommit);
    if (moved.length > 0) throw new CodepatrolError("VERIFY_STALE", `The candidate moved during Verify: ${moved.join(", ")}.`);
    const { hash } = await this.policyAt(currentCommit);
    if (hash !== pinned.policyHash) {
      throw new CodepatrolError("VERIFY_STALE", `${VERIFY_POLICY_PATH} changed during Verify; verify the candidate again under the current policy.`);
    }
  }

  async assertShipVerification(manifest: WorkManifest, currentCommit: string, targetCommit: string, movedSince: (candidate: string, head: string) => Promise<string[]>): Promise<void> {
    const verify = [...manifest.attempts].reverse().find((attempt) => attempt.stage === "verify" && attempt.status === "completed" && attempt.result?.decision === "continue");
    const snapshot = verify?.verifiedCandidate;
    if (snapshot === undefined) throw new CodepatrolError("VERIFY_STALE", "Ship has no standing verified candidate.");
    if (snapshot.targetCommit !== targetCommit || snapshot.baselineCommit !== manifest.repository.baselineCommit) {
      throw new CodepatrolError("VERIFY_STALE", "The base changed after Verify; refresh and verify the Change again.", 1, {
        expected: `base ${snapshot.targetCommit} and baseline ${snapshot.baselineCommit}`,
        observed: `base ${targetCommit} and baseline ${manifest.repository.baselineCommit}`,
        committed: ["the Change and its verification are intact; the base was not moved"],
        nextCommand: `codepatrol change refresh ${manifest.work.id}`,
      });
    }
    if (snapshot.attempt !== verify?.attempt) throw new CodepatrolError("VERIFY_STALE", "The standing verification belongs to another attempt.");
    const offenders = await movedSince(snapshot.candidateCommit, currentCommit);
    if (offenders.length > 0) throw new CodepatrolError("VERIFY_STALE", `The Change moved after Verify: ${offenders.join(", ")}.`);
    const { hash } = await this.policyAt(currentCommit);
    if (hash !== snapshot.policyHash) {
      throw new CodepatrolError("VERIFY_STALE", `${VERIFY_POLICY_PATH} changed after Verify; verify the candidate again under the current policy.`);
    }
  }
}
