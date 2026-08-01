/**
 * What an operator needs to recover, alongside the failure itself.
 *
 * A refused command has often already committed something — a manifest
 * checkpoint, an archive ref — and the dangerous move is to guess. Naming the
 * state that was expected, the state that was found, the facts that survived,
 * and one safe next command turns a refusal into an instruction.
 */
export interface ErrorRecovery {
  expected?: string;
  observed?: string;
  /** Local facts the failure did not undo, and must not be redone blindly. */
  committed?: string[];
  /** The single command that is safe to run next. */
  nextCommand?: string;
}

export class CodepatrolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly exitCode = 1,
    readonly recovery?: ErrorRecovery,
  ) {
    super(message);
    this.name = "CodepatrolError";
  }

  /** The same failure, told with what it takes to recover from it. */
  withRecovery(recovery: ErrorRecovery): CodepatrolError {
    return new CodepatrolError(this.code, this.message, this.exitCode, { ...this.recovery, ...recovery });
  }
}
