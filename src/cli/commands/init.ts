import { CodepatrolError } from "../../core/errors.js";
import type { Harness, ProjectConfig } from "../../core/repository-config.js";
import type { CommandSpec } from "../command.js";
import { exactPositionals, parseArgs } from "../args.js";

function commands(raw: string | undefined): string[][] | undefined {
  if (raw === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new CodepatrolError("INVALID_ARGUMENT", `--verify-commands must be JSON: ${error instanceof Error ? error.message : String(error)}.`, 2);
  }
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => !Array.isArray(item) || item.length === 0 || item.some((part) => typeof part !== "string" || part === ""))) {
    throw new CodepatrolError("INVALID_ARGUMENT", "--verify-commands must be a non-empty JSON array of non-empty argument arrays.", 2);
  }
  return value as string[][];
}

export const initCommand: CommandSpec = {
  name: "init",
  summary: "Initialize repository policy, configuration, and harness adapters.",
  usage: ["init [--base <branch>] [--verify-commands '<json>'] [--harness opencode|claude|none] [--github] [--project disabled|managed|existing] [--project-number <number>] [--replace]"],
  async run(context, argv) {
    const args = parseArgs(argv, ["base", "verify-commands", "harness", "github", "project", "project-number", "replace"]);
    exactPositionals(args, 0, "no positional arguments");
    const harness = args.flags.get("harness") ?? "none";
    if (!["none", "opencode", "claude"].includes(harness)) throw new CodepatrolError("INVALID_ARGUMENT", "--harness must be none, opencode, or claude.", 2);
    const mode = args.flags.get("project") ?? "disabled";
    if (!["disabled", "managed", "existing"].includes(mode)) throw new CodepatrolError("INVALID_ARGUMENT", "--project must be disabled, managed, or existing.", 2);
    const number = args.flags.get("project-number");
    let project: ProjectConfig;
    if (mode === "existing") {
      const parsed = Number(number);
      if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new CodepatrolError("INVALID_ARGUMENT", "--project existing requires a positive --project-number.", 2);
      project = { mode: "existing", number: parsed };
    } else {
      if (number !== undefined) throw new CodepatrolError("INVALID_ARGUMENT", "--project-number is only valid with --project existing.", 2);
      project = { mode: mode as "disabled" | "managed" };
    }
    const baseBranch = args.flags.get("base");
    const requiredCommands = commands(args.flags.get("verify-commands"));
    return context.initialization.run({
      harness: harness as Harness,
      github: args.flags.has("github"),
      project,
      replace: args.flags.has("replace"),
      ...(baseBranch === undefined ? {} : { baseBranch }),
      ...(requiredCommands === undefined ? {} : { requiredCommands }),
    });
  },
};
