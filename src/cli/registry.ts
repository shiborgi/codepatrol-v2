import type { CommandSpec } from "./command.js";
import { changeCommand } from "./commands/change.js";
import { specCommand } from "./commands/spec.js";
import { initiativeCommand } from "./commands/initiative.js";
import { skillCommand } from "./commands/skill.js";
import { stageCommand } from "./commands/stage.js";
import { syncCommand } from "./commands/sync.js";
import { workCommand } from "./commands/work.js";
import { initCommand } from "./commands/init.js";
import { doctorCommand } from "./commands/doctor.js";
import { STAGES } from "../core/types.js";
import { VERSION } from "./version.js";

export type { CommandContext, CommandSpec } from "./command.js";

export const COMMANDS: readonly CommandSpec[] = [
  initCommand,
  doctorCommand,
  specCommand,
  workCommand,
  initiativeCommand,
  skillCommand,
  changeCommand,
  syncCommand,
  ...STAGES.map(stageCommand),
];

export function helpText(): string {
  const lines = [
    `codepatrol ${VERSION}`,
    "",
    "Usage: codepatrol [--workspace <path>] <command> ...",
    "",
    "Commands:",
  ];
  for (const command of COMMANDS) {
    lines.push(`  ${command.name.padEnd(8)} ${command.summary}`);
    for (const usage of command.usage) lines.push(`             codepatrol ${usage}`);
  }
  lines.push(
    "",
    "All successful command output is JSON. Unknown flags and fields are rejected.",
    "Every command works without a Git remote; publication then reports \"skipped\".",
  );
  return lines.join("\n");
}
