import { exactPositionals, parseArgs } from "../args.js";
import type { CommandSpec } from "../command.js";
import { CodepatrolError } from "../../core/errors.js";

/**
 * Read-only access to Works.
 *
 * Creating and restructuring Works is not here by design: it happens only by
 * applying a validated Initiative document, so there is no path that produces a Work
 * without a recorded provenance and a checked graph.
 */
export const workCommand: CommandSpec = {
  name: "work",
  summary: "Inspect Works and their dependency graph. Reads are local and need no remote.",
  usage: [
    "work list",
    "work show <work-id>",
    "work graph",
    "work checkout <work-id>",
  ],
  async run(context, rawArgs) {
    const action = rawArgs[0];
    // Checked before parsing flags, so `work create --type ...` explains where
    // Works come from instead of complaining about an unknown flag.
    if (action === "create") {
      throw new CodepatrolError("INVALID_ARGUMENT", "Works are created only by applying an Initiative document; use the codepatrol-spec skill, then codepatrol spec apply.", 2);
    }
    const args = parseArgs(rawArgs.slice(1), []);
    if (action === "list") {
      exactPositionals(args, 0, "no positional arguments after work list");
      return context.works.list();
    }
    if (action === "graph") {
      exactPositionals(args, 0, "no positional arguments after work graph");
      return context.works.graph();
    }
    if (action === "show") {
      exactPositionals(args, 1, "work show <work-id>");
      return context.works.show(args.positionals[0] as string);
    }
    if (action === "checkout") {
      exactPositionals(args, 1, "work checkout <work-id>");
      const workId = args.positionals[0] as string;
      return { workId, worktreeDirectory: await context.works.checkout(workId) };
    }
    throw new CodepatrolError("INVALID_ARGUMENT", "work action must be list, show, graph, or checkout.", 2);
  },
};
