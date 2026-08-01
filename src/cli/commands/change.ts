import { exactPositionals, parseArgs } from "../args.js";
import type { CommandSpec } from "../command.js";
import { CodepatrolError } from "../../core/errors.js";

export const changeCommand: CommandSpec = {
  name: "change",
  summary: "Inspect the delivery candidate a Work produces.",
  usage: ["change show <work-id>", "change diff <work-id>", "change refresh <work-id>"],
  async run(context, rawArgs) {
    const action = rawArgs[0];
    const args = parseArgs(rawArgs.slice(1), []);
    exactPositionals(args, 1, `change ${action ?? "<action>"} <work-id>`);
    const workId = args.positionals[0] as string;
    if (action === "show") return (await context.works.show(workId)).change;
    if (action === "diff") return context.works.inspect(workId);
    if (action === "refresh") return context.works.refresh(workId);
    throw new CodepatrolError("INVALID_ARGUMENT", "change action must be show, diff, or refresh.", 2);
  },
};
