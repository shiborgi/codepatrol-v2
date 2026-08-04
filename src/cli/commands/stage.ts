import { exactPositionals, parseArgs, readJsonFile, requiredFlag } from "../args.js";
import { published, publish, type CommandSpec } from "../command.js";
import { parseResult, parseTelemetryInput, parseTodo, parseTrace } from "../inputs.js";
import { CodepatrolError } from "../../core/errors.js";
import { STAGE_ROLES, type Stage } from "../../core/types.js";

/**
 * The five lifecycle stages share one command shape; only their role and their
 * permitted decisions differ, and both are fixed by the core rather than here.
 */
export function stageCommand(stage: Stage): CommandSpec {
  return {
    name: stage,
    summary: `Run the ${stage} step as the ${STAGE_ROLES[stage]} role.`,
    usage: [
      `${stage} start <work-id> --harness <id> --model <id> --todo <todo.json> [--worktree]`,
      `${stage} resume <work-id>`,
      `${stage} trace <work-id> --run <run-id> --input <trace.json>`,
      `${stage} complete <work-id> --run <run-id> --result <result.json> [--telemetry <telemetry.json>]`,
    ],
    async run(context, rawArgs) {
      const action = rawArgs[0];
      const allowedFlags = action === "start" ? ["harness", "model", "todo", "worktree"]
        : action === "trace" ? ["run", "input"]
          : action === "complete" ? ["run", "result", "telemetry"]
            : [];
      const args = parseArgs(rawArgs.slice(1), allowedFlags);
      exactPositionals(args, 1, `${stage} ${action ?? "<action>"} <work-id>`);
      const workId = args.positionals[0] as string;
      if (action === "start") {
        const todo = parseTodo(await readJsonFile(context.workspace, requiredFlag(args, "todo")));
        const started = await context.works.start(stage, workId, requiredFlag(args, "harness"), requiredFlag(args, "model"), todo, {
          ...(args.flags.get("worktree") === "true" ? { worktree: true } : {}),
        });
        return published(started, await publish(context, workId));
      }
      if (action === "resume") return context.works.resume(stage, workId);
      if (action === "trace") {
        const entry = parseTrace(await readJsonFile(context.workspace, requiredFlag(args, "input")));
        return { workId, stage, trace: await context.works.trace(stage, workId, requiredFlag(args, "run"), entry) };
      }
      if (action === "complete") {
        const result = parseResult(await readJsonFile(context.workspace, requiredFlag(args, "result")), stage);
        const telemetryFlag = args.flags.get("telemetry");
        const telemetryOptions = telemetryFlag === undefined ? {} : { telemetry: parseTelemetryInput(await readJsonFile(context.workspace, telemetryFlag)) };
        const completed = await context.works.complete(stage, workId, requiredFlag(args, "run"), result, telemetryOptions);
        return published(completed, await publish(context, workId));
      }
      throw new CodepatrolError("INVALID_ARGUMENT", `${stage} action must be start, resume, trace, or complete.`, 2);
    },
  };
}
