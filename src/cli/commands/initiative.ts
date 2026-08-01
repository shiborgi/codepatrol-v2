import { exactPositionals, parseArgs } from "../args.js";
import type { CommandSpec } from "../command.js";
import { CodepatrolError } from "../../core/errors.js";

/**
 * Initiatives, read back.
 *
 * An Initiative is created by Spec and lives on its own ref; this command only
 * reads. Membership is derived from Work identifiers, so there is nothing here
 * that can drift from the graph.
 */
export const initiativeCommand: CommandSpec = {
  name: "initiative",
  summary: "List and inspect Initiatives. Derived membership; changes nothing.",
  usage: ["initiative list", "initiative show <initiative-id>"],
  async run(context, rawArgs) {
    const action = rawArgs[0];
    const args = parseArgs(rawArgs.slice(1), []);
    if (action === "list") {
      exactPositionals(args, 0, "no positional arguments after initiative list");
      return { initiatives: await context.initiatives.list() };
    }
    if (action === "show") {
      exactPositionals(args, 1, "exactly one Initiative id after initiative show");
      return context.initiatives.show(args.positionals[0] as string);
    }
    throw new CodepatrolError("INVALID_ARGUMENT", "initiative action must be list or show.", 2);
  },
};
