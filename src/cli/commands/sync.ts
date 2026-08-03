import { exactPositionals, parseArgs } from "../args.js";
import { publish, type CommandSpec } from "../command.js";
import { CodepatrolError } from "../../core/errors.js";
import { WORK_CODE, WORK_ID } from "../../core/identifiers.js";

export const syncCommand: CommandSpec = {
  name: "sync",
  summary: "Project local state onto GitHub. Never required; never governs.",
  usage: ["sync [--work <work-id>]"],
  async run(context, rawArgs) {
    const args = parseArgs(rawArgs, ["work"]);
    exactPositionals(args, 0, "no positional arguments for sync");
    const workId = args.flags.get("work");
    if (workId !== undefined && !WORK_ID.test(workId) && !WORK_CODE.test(workId)) {
      throw new CodepatrolError("INVALID_WORK_ID", `Invalid work id: ${workId}.`, 2);
    }
    return publish(context, workId, true);
  },
};
