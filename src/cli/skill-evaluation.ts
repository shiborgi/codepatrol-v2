import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CodepatrolError } from "../core/errors.js";
import { resolveComposition, type SkillComposition } from "../core/skill-resolution.js";
import type { SkillManifest } from "../core/skill.js";
import { parseSkillSuite, type Assertion, type ScenarioResult, type SkillSuite } from "../core/skill-suite.js";

const evaluationBin = path.resolve(fileURLToPath(import.meta.url), "../../../bin/codepatrol.js");
const shippedSkillsDirectory = path.resolve(fileURLToPath(import.meta.url), "../../../skills");

/**
 * The capabilities the host running this evaluation truthfully offers. Scenarios
 * that declare an optional capability the host does not provide are skipped,
 * never silently passed: a host without the capability cannot prove the
 * assertion's claim.
 */
const HOST_CAPABILITIES = ["cli"] as const;

export interface SuiteSummary {
  total: number;
  passed: number;
  failed: number;
  errored: number;
  skipped: number;
  unresolved: number;
}

export interface SuiteOutcome {
  skill: { id: string; version: string; digest: string };
  resolutionDigest: string;
  results: ScenarioResult[];
  summary: SuiteSummary;
}

/**
 * Run every scenario in `suite`, returning one `ScenarioResult` per scenario
 * with the resolved skill identity and composition digest. The runner never
 * reads from or writes to the caller's repository: command assertions execute
 * against a throwaway fixture whose only preconditions are the suite's setup
 * commands.
 */
export async function runSkillSuite(suite: SkillSuite, manifests: readonly SkillManifest[], skillsDirectory: string, cliPath: string = evaluationBin): Promise<SuiteOutcome> {
  const skill = manifests.find((manifest) => manifest.id === suite.skill);
  if (skill === undefined) {
    throw new CodepatrolError("STATE_CORRUPT", `Suite names skill ${suite.skill} but it is not in the manifest set.`);
  }
  const composition = resolveComposition(suite.skill.startsWith("codepatrol-") ? (suite.skill.slice("codepatrol-".length) as never) : "plan", manifests, [...HOST_CAPABILITIES]);
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "codepatrol-eval-"));
  const scratchRoot = await mkdtemp(path.join(tmpdir(), "codepatrol-eval-scratch-"));
  // Plant a default todo file outside the fixture repository, in the scratch
  // sibling: the CLI requires JSON control files to live outside both the
  // workspace and its worktrees.
  const todoPath = path.join(scratchRoot, "todo.json");
  await writeFile(todoPath, `${JSON.stringify([{ id: "T1", title: "evaluate" }])}\n`, "utf8");
  try {
    const results: ScenarioResult[] = [];
    for (const scenario of suite.scenarios) {
      const result = await runScenario(scenario, skill, composition, skillsDirectory, cliPath, fixtureRoot, scratchRoot, todoPath);
      results.push(result);
    }
    const summary = summarize(results);
    return {
      skill: { id: skill.id, version: skill.version, digest: skill.digest },
      resolutionDigest: composition.digest,
      results,
      summary,
    };
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    await rm(scratchRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

function summarize(results: readonly ScenarioResult[]): SuiteSummary {
  const counts: SuiteSummary = { total: results.length, passed: 0, failed: 0, errored: 0, skipped: 0, unresolved: 0 };
  for (const result of results) {
    if (result.status === "passed") counts.passed += 1;
    else if (result.status === "failed") counts.failed += 1;
    else if (result.status === "error") counts.errored += 1;
    else if (result.status === "skipped") counts.skipped += 1;
    else counts.unresolved += 1;
  }
  return counts;
}

interface ScenarioRunnerContext {
  readonly skill: SkillManifest;
  readonly composition: SkillComposition;
  readonly fixtureRoot: string;
  readonly scratchRoot: string;
  readonly skillsDirectory: string;
  readonly cliPath: string;
  readonly todoPath: string;
}

async function runScenario(
  scenario: SkillSuite["scenarios"][number],
  skill: SkillManifest,
  composition: SkillComposition,
  skillsDirectory: string,
  cliPath: string,
  fixtureRoot: string,
  scratchRoot: string,
  todoPath: string,
): Promise<ScenarioResult> {
  const identity = { id: skill.id, version: skill.version, digest: skill.digest };
  const base = { skill: identity, resolutionDigest: composition.digest };
  const context: ScenarioRunnerContext = { skill, composition, fixtureRoot, scratchRoot, skillsDirectory, cliPath, todoPath };
  for (const assertion of scenario.assertions) {
    const verdict = await runAssertion(assertion, context);
    if (verdict !== null) {
      return { id: scenario.id, status: verdict.status, ...(verdict.detail === undefined ? {} : { detail: verdict.detail }), ...base };
    }
  }
  return { id: scenario.id, status: "passed", ...base };
}

interface Verdict {
  status: ScenarioResult["status"];
  detail?: string;
}

async function runAssertion(assertion: Assertion, context: ScenarioRunnerContext): Promise<Verdict | null> {
  if (assertion.kind === "content-includes" || assertion.kind === "content-excludes") {
    const target = await readSkillBytes(assertion.skill, context.skillsDirectory);
    const re = safeRegex(assertion.pattern, "Suite assertion pattern");
    const matched = re.test(target);
    const includes = assertion.kind === "content-includes";
    if (matched === includes) return null;
    return { status: "failed", detail: `${assertion.kind} did not hold: pattern ${JSON.stringify(assertion.pattern)} ${includes ? "did not match" : "matched"} ${assertion.skill}.` };
  }
  if (assertion.kind === "command") {
    const workspace = await prepareFixture(context, assertion.setup ?? []);
    if ("error" in workspace) return workspace.error;
    const result = await runCommand(context.cliPath, assertion.argv, workspace.path, context.todoPath);
    if (result.code !== assertion.exitCode) {
      return { status: "failed", detail: `Command exit ${result.code}, expected ${assertion.exitCode}; stderr: ${truncate(result.stderr)}` };
    }
    if (assertion.stderr !== undefined) {
      const re = safeRegex(assertion.stderr, "Suite assertion stderr");
      if (!re.test(result.stderr)) return { status: "failed", detail: `stderr ${JSON.stringify(result.stderr)} did not match ${JSON.stringify(assertion.stderr)}` };
    }
    if (assertion.stdout !== undefined) {
      const re = safeRegex(assertion.stdout, "Suite assertion stdout");
      if (!re.test(result.stdout)) return { status: "failed", detail: `stdout did not match ${JSON.stringify(assertion.stdout)}` };
    }
    return null;
  }
  return { status: "error", detail: `Unsupported assertion kind: ${(assertion as { kind: string }).kind}.` };
}

async function readSkillBytes(skillId: string, skillsDirectory: string): Promise<string> {
  const path_ = path.join(skillsDirectory, skillId, "SKILL.md");
  try {
    return await readFile(path_, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new CodepatrolError("STATE_CORRUPT", `Suite references skill ${skillId} but ${path_} is missing.`);
    }
    throw error;
  }
}

function safeRegex(pattern: string, label: string): RegExp {
  try {
    return new RegExp(pattern, "m");
  } catch (error) {
    throw new CodepatrolError("STATE_CORRUPT", `${label} is not a valid regex: ${(error as Error).message}.`);
  }
}

function truncate(value: string, max = 240): string {
  const trimmed = value.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 3)}...`;
}

async function prepareFixture(context: ScenarioRunnerContext, setup: Array<{ argv: string[]; exitCode?: number }>): Promise<{ path: string } | { error: Verdict }> {
  const path_ = await mkdtemp(path.join(context.fixtureRoot, "fixture-"));
  await gitInit(path_);
  for (const [index, command] of setup.entries()) {
    const result = await runCommand(context.cliPath, command.argv, path_, context.todoPath);
    if (result.code !== (command.exitCode ?? 0)) {
      const detail = `setup[${index}] exited with ${result.code}, expected ${command.exitCode ?? 0}; stderr: ${truncate(result.stderr)}`;
      return { error: { status: "error", detail } };
    }
  }
  return { path: path_ };
}

async function gitInit(workspace: string): Promise<void> {
  const hooksPath = process.platform === "win32" ? "NUL" : "/dev/null";
  const env = scrubbedEnvironment(hooksPath);
  await runCaptured("git", ["-c", `core.hooksPath=${hooksPath}`, "init", "-b", "main"], workspace, env);
  await runCaptured("git", ["-c", `core.hooksPath=${hooksPath}`, "config", "gc.auto", "0"], workspace, env);
  await runCaptured("git", ["-c", `core.hooksPath=${hooksPath}`, "config", "user.email", "codepatrol@local.invalid"], workspace, env);
  await runCaptured("git", ["-c", `core.hooksPath=${hooksPath}`, "config", "user.name", "Codepatrol"], workspace, env);
  // An initial commit is what the init command expects to anchor base-resolution
  // against; without HEAD, baseRef has nothing to resolve to.
  await writeFile(path.join(workspace, ".gitkeep"), "", "utf8");
  await runCaptured("git", ["-c", `core.hooksPath=${hooksPath}`, "add", ".gitkeep"], workspace, env);
  await runCaptured("git", ["-c", `core.hooksPath=${hooksPath}`, "commit", "-q", "-m", "bootstrap"], workspace, env);
}

function scrubbedEnvironment(hooksPath: string): NodeJS.ProcessEnv {
  // Offline by construction: no model or remote credentials reach the
  // child process, and credential-ish variables are removed so a deliberate
  // push or fetch in a scenario cannot authenticate. GIT_TERMINAL_PROMPT=0
  // refuses a prompt even if a hostile command tries to read credentials.
  const dropList = ["GITHUB_TOKEN", "GH_TOKEN", "CODECOV_TOKEN", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"];
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" };
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (dropList.includes(key)) continue;
    env[key] = value;
  }
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  env.GIT_CONFIG_SYSTEM = "/dev/null";
  env.CORE_PATHSH_CONFIRM = "0";
  void hooksPath;
  return env;
}

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCommand(commandPath: string, argv: string[], workspace: string, todoPath?: string): Promise<CommandResult> {
  const env = scrubbedEnvironment(process.platform === "win32" ? "NUL" : "/dev/null");
  // Substitute "todo.json" / "result.json" / "trace.json" / "input.json" in
  // argv for the runner's pre-planted path, so the suite's fixture-relative
  // path lands on the file the runner wrote. Other JSON paths are left
  // alone: the suite has to author them explicitly.
  const resolved = argv.map((entry) => {
    if (todoPath === undefined) return entry;
    if (entry === "todo.json" || entry === "result.json" || entry === "trace.json" || entry === "input.json") return todoPath;
    return entry;
  });
  const args = [commandPath, "--workspace", workspace, ...resolved];
  return await runCaptured(process.execPath, args, workspace, env);
}

function runCaptured(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({
      code: code ?? 1,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    }));
  });
}

/**
 * Load a suite by id from the shipped skills directory. Returns a parsed
 * suite, or refuses STATE_CORRUPT when the file is missing or malformed.
 */
export async function loadShippedSuite(skillId: string): Promise<SkillSuite> {
  const path_ = path.join(shippedSkillsDirectory, skillId, "suite.json");
  try {
    const raw = await readFile(path_, "utf8");
    return parseSkillSuite(JSON.parse(raw));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new CodepatrolError("STATE_CORRUPT", `No suite shipped for skill ${skillId}.`);
    }
    throw error;
  }
}

/**
 * A scenario is resolvable when the named skill is included in the resolved
 * composition. A scenario whose assertion names an unknown skill surfaces as
 * unresolved in the result rather than a runner error.
 */
export async function runShippedSuite(skillId: string, manifests: readonly SkillManifest[]): Promise<SuiteOutcome> {
  const suite = await loadShippedSuite(skillId);
  return runSkillSuite(suite, manifests, shippedSkillsDirectory);
}