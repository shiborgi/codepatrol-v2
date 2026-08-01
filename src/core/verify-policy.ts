import { CodepatrolError } from "./errors.js";
import { sha256 } from "./json.js";
import type { ManifestTrace } from "./work-manifest.js";

/** Where the repository states what Verify must actually run. */
export const VERIFY_POLICY_PATH = ".codepatrol/policy.json";

export interface VerifyPolicy {
  /**
   * Commands that must each have a fresh, successful execution before Verify
   * may continue. Argument arrays rather than shell strings: the comparison is
   * exact, and there is nothing for a shell to reinterpret.
   */
  requiredCommands: string[][];
  /**
   * Whether a redacted tail of each command's output is kept in the manifest.
   *
   * Off by default. The manifest reaches the base branch and is pushed, and
   * redaction catches known credential shapes rather than all of them, so
   * keeping nothing is the only default that cannot leak. The full output is
   * always written to the disposable runtime for diagnosis.
   */
  persistOutputExcerpt: boolean;
}

function fail(message: string): never {
  throw new CodepatrolError("INVALID_POLICY", message);
}

function required(message: string): never {
  throw new CodepatrolError("VERIFY_POLICY_REQUIRED", message, 1, {
    expected: `${VERIFY_POLICY_PATH} with at least one required command`,
    observed: message,
    nextCommand: "codepatrol init",
  });
}

/**
 * Renders the policy canonically so its hash depends on what it says, not on
 * how it was typed. Reformatting `policy.json` must not invalidate a standing
 * verification.
 */
export function serializeVerifyPolicy(policy: VerifyPolicy): string {
  return JSON.stringify({ verify: { requiredCommands: policy.requiredCommands, persistOutputExcerpt: policy.persistOutputExcerpt } });
}

export function verifyPolicyHash(policy: VerifyPolicy): string {
  return sha256(serializeVerifyPolicy(policy));
}

export function parseVerifyPolicy(raw: string): VerifyPolicy {
  let document: unknown;
  try {
    document = JSON.parse(raw) as unknown;
  } catch (error) {
    fail(`${VERIFY_POLICY_PATH} contains invalid JSON: ${error instanceof Error ? error.message : String(error)}.`);
  }
  if (document === null || typeof document !== "object" || Array.isArray(document)) fail(`${VERIFY_POLICY_PATH} must be an object.`);
  const record = document as Record<string, unknown>;
  const unknown = Object.keys(record).find((key) => key !== "verify");
  if (unknown !== undefined) fail(`${VERIFY_POLICY_PATH} has an unknown field: ${unknown}.`);
  if (record.verify === undefined) required(`${VERIFY_POLICY_PATH} must declare verify.requiredCommands.`);
  if (record.verify === null || typeof record.verify !== "object" || Array.isArray(record.verify)) fail(`${VERIFY_POLICY_PATH} verify must be an object.`);
  const verify = record.verify as Record<string, unknown>;
  const unknownVerify = Object.keys(verify).find((key) => !["requiredCommands", "persistOutputExcerpt"].includes(key));
  if (unknownVerify !== undefined) fail(`${VERIFY_POLICY_PATH} verify has an unknown field: ${unknownVerify}.`);
  if (verify.requiredCommands === undefined) required(`${VERIFY_POLICY_PATH} must declare verify.requiredCommands.`);
  if (!Array.isArray(verify.requiredCommands)) fail(`${VERIFY_POLICY_PATH} verify.requiredCommands must be an array.`);
  if (verify.requiredCommands.length === 0) required(`${VERIFY_POLICY_PATH} verify.requiredCommands must not be empty.`);
  const requiredCommands = verify.requiredCommands.map((entry, index) => {
    const label = `${VERIFY_POLICY_PATH} verify.requiredCommands[${index}]`;
    if (!Array.isArray(entry) || entry.length === 0) fail(`${label} must be a non-empty argument array.`);
    return entry.map((part, position) => {
      if (typeof part !== "string" || part === "") fail(`${label}[${position}] must be a non-empty string.`);
      return part;
    });
  });
  if (verify.persistOutputExcerpt !== undefined && typeof verify.persistOutputExcerpt !== "boolean") {
    fail(`${VERIFY_POLICY_PATH} verify.persistOutputExcerpt must be a boolean.`);
  }
  return { requiredCommands, persistOutputExcerpt: verify.persistOutputExcerpt === true };
}

export function renderCommand(command: readonly string[]): string {
  return command.join(" ");
}

/**
 * Which required commands this attempt has not demonstrably run.
 *
 * Only traces recorded by the run being completed are considered, so a result
 * copied from an earlier attempt — or from another Work — proves nothing. The
 * match is on the exact argument array: `npm run verify` does not satisfy a
 * policy that requires `npm run verify -- --ci`.
 */
export function unsatisfiedCommands(policy: VerifyPolicy, traces: readonly ManifestTrace[]): string[][] {
  const succeeded = traces.filter((trace) => trace.type === "command" && trace.exitCode === 0 && trace.command !== undefined);
  return policy.requiredCommands.filter((required) =>
    !succeeded.some((trace) => {
      const actual = trace.command as string[];
      return actual.length === required.length && actual.every((part, index) => part === required[index]);
    }),
  );
}
