import { exactPositionals, parseArgs, readJsonFile, requiredFlag } from "../args.js";
import { published, publish, type CommandSpec } from "../command.js";
import { parseResult, parseTodo, parseTrace } from "../inputs.js";
import { CodepatrolError } from "../../core/errors.js";
import { SKILL_ID } from "../../core/identifiers.js";
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
      `${stage} start <work-id> --harness <id> --model <id> --todo <todo.json> [--skills <id,id,...>] [--worktree]`,
      `${stage} resume <work-id>`,
      `${stage} trace <work-id> --run <run-id> --input <trace.json>`,
      `${stage} complete <work-id> --run <run-id> --result <result.json>`,
    ],
    async run(context, rawArgs) {
      const action = rawArgs[0];
      const allowedFlags = action === "start" ? ["harness", "model", "todo", "skills", "worktree"]
        : action === "trace" ? ["run", "input"]
          : action === "complete" ? ["run", "result"]
            : [];
      const args = parseArgs(rawArgs.slice(1), allowedFlags);
      exactPositionals(args, 1, `${stage} ${action ?? "<action>"} <work-id>`);
      const workId = args.positionals[0] as string;
      if (action === "start") {
        const todo = parseTodo(await readJsonFile(context.workspace, requiredFlag(args, "todo")));
        const declaredSkills = parseSkillsFlag(args.flags.get("skills"));
        const started = await context.works.start(stage, workId, requiredFlag(args, "harness"), requiredFlag(args, "model"), todo, {
          ...(args.flags.get("worktree") === "true" ? { worktree: true } : {}),
          ...(declaredSkills === undefined ? {} : { declaredSkills }),
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
        const completed = await context.works.complete(stage, workId, requiredFlag(args, "run"), result);
        return published(completed, await publish(context, workId));
      }
      throw new CodepatrolError("INVALID_ARGUMENT", `${stage} action must be start, resume, trace, or complete.`, 2);
    },
  };
}

/**
 * Parses `--skills <id,id,...>` into a deduplicated, sorted array of skill
 * ids. An empty list or missing flag is `undefined` — no declaration.
 */
function parseSkillsFlag(raw: string | undefined): string[] | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const tokens = raw.split(",").map((token) => token.trim()).filter((token) => token !== "");
  if (tokens.length === 0) return undefined;
  const unique = Array.from(new Set(tokens));
  for (const id of unique) {
    if (!SKILL_ID.test(id)) throw new CodepatrolError("INVALID_ARGUMENT", `Skill id in --skills is invalid: ${id}.`, 2);
  }
  return unique.sort();
}
