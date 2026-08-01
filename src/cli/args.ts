import { readFile } from "node:fs/promises";
import path from "node:path";
import { CodepatrolError } from "../core/errors.js";

export interface ParsedArgs {
  positionals: string[];
  flags: Map<string, string>;
}

/** Flags that are switches rather than name/value pairs. */
const VALUELESS_FLAGS = new Set(["worktree", "from-ci", "github", "replace"]);

/**
 * Parses `--flag value` and bare positionals, rejecting anything the command
 * did not declare. Being strict here is what lets a typo fail loudly instead of
 * silently running a different operation.
 */
export function parseArgs(args: string[], allowedFlags: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === undefined) continue;
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const name = token.slice(2);
    if (!allowedFlags.includes(name)) throw new CodepatrolError("INVALID_ARGUMENT", `Unknown flag: --${name}.`, 2);
    if (flags.has(name)) throw new CodepatrolError("INVALID_ARGUMENT", `Duplicate flag: --${name}.`, 2);
    if (VALUELESS_FLAGS.has(name)) {
      flags.set(name, "true");
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) throw new CodepatrolError("INVALID_ARGUMENT", `Flag --${name} requires a value.`, 2);
    flags.set(name, value);
    index += 1;
  }
  return { positionals, flags };
}

export function requiredFlag(args: ParsedArgs, name: string): string {
  const value = args.flags.get(name);
  if (value === undefined || value.trim() === "") throw new CodepatrolError("INVALID_ARGUMENT", `Missing --${name}.`, 2);
  return value;
}

export function exactPositionals(args: ParsedArgs, expected: number, usage: string): void {
  if (args.positionals.length !== expected) throw new CodepatrolError("INVALID_ARGUMENT", `Expected ${usage}.`, 2);
}

const MAX_INPUT_BYTES = 1_000_000;

/**
 * Reads a control document supplied by an executor.
 *
 * The path must be absolute and outside the repository: control JSON is command
 * input, not product content, and a file inside a Change would end up committed
 * or reported as a pending change.
 */
export async function readJsonFile(workspace: string, file: string): Promise<unknown> {
  if (!path.isAbsolute(file)) throw new CodepatrolError("INVALID_ARGUMENT", `JSON input path must be absolute: ${file}.`, 2);
  const absolute = path.resolve(file);
  const relative = path.relative(path.resolve(workspace), absolute);
  if (relative === "" || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative))) {
    throw new CodepatrolError("INVALID_ARGUMENT", `JSON input must be outside the repository and its worktrees: ${file}.`, 2);
  }
  try {
    const contents = await readFile(absolute, "utf8");
    if (Buffer.byteLength(contents) > MAX_INPUT_BYTES) throw new CodepatrolError("INVALID_INPUT", `JSON input exceeds ${MAX_INPUT_BYTES} bytes: ${file}.`, 2);
    return JSON.parse(contents) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) throw new CodepatrolError("INVALID_JSON", `Invalid JSON in ${file}: ${error.message}.`, 2);
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new CodepatrolError("FILE_NOT_FOUND", `File not found: ${file}.`, 2);
    throw error;
  }
}
