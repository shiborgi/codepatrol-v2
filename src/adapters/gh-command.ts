import { spawn } from "node:child_process";
import { CodepatrolError } from "../core/errors.js";

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const TIMEOUT_MS = 120_000;

export async function executeGh(args: string[]): Promise<string> {
  const result = await new Promise<CommandResult>((resolve, reject) => {
    const child = spawn("gh", args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      reject(error);
    };
    const collect = (target: Buffer[], chunk: Buffer): void => {
      outputBytes += chunk.byteLength;
      if (outputBytes > MAX_OUTPUT_BYTES) fail(new CodepatrolError("GH_ERROR", "gh output exceeded the 10 MiB safety limit."));
      else target.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    const timer = setTimeout(() => fail(new CodepatrolError("GH_ERROR", `gh ${args.slice(0, 2).join(" ")} timed out.`)), TIMEOUT_MS);
    timer.unref();
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") fail(new CodepatrolError("GH_NOT_FOUND", "The gh CLI is required for GitHub publication."));
      else fail(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
    });
  });
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `gh exited with ${result.code}`;
    throw new CodepatrolError("GH_ERROR", `gh ${args.slice(0, 2).join(" ")} failed: ${detail}`);
  }
  return result.stdout.trim();
}

export function parseGhJson(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) throw new CodepatrolError("GH_ERROR", `${label} returned invalid JSON.`);
    throw error;
  }
}
