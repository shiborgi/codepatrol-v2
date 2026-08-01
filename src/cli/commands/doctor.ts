import type { CommandSpec } from "../command.js";
import { exactPositionals, parseArgs } from "../args.js";

export const doctorCommand: CommandSpec = {
  name: "doctor",
  summary: "Diagnose repository and optional projection readiness.",
  usage: ["doctor"],
  async run(context, argv) {
    const args = parseArgs(argv, []);
    exactPositionals(args, 0, "no arguments");
    const result = await context.doctor.run();
    if (result.status === "failed") context.setExitCode?.(1);
    return result;
  },
};
