import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { exactPositionals, parseArgs } from "../args.js";
import type { CommandSpec } from "../command.js";
import { CodepatrolError } from "../../core/errors.js";
import { resolveComposition } from "../../core/skill-resolution.js";
import { parseSkillManifest, skillContentDigest, type SkillManifest } from "../../core/skill.js";
import { STAGES } from "../../core/types.js";
import { runShippedSuite } from "../skill-evaluation.js";

// The CLI is the only layer allowed to read the filesystem; core stays pure.
const shippedSkillsDirectory = path.resolve(fileURLToPath(import.meta.url), "../../../../skills");

/**
 * The capabilities this CLI host truthfully offers. The resolver uses the
 * intersection of the included skills' declared capabilities and this set to
 * decide whether a stage can run on this host. Adding a new capability is a
 * real change: it requires the host to actually support it, not just declare
 * it.
 */
const HOST_CAPABILITIES = ["cli"] as const;

/**
 * Reads the skills this codepatrol installation ships: each skills/<id>/
 * directory must carry a manifest that parses, names its directory, and
 * reproduces its recorded digest from SKILL.md alone. A manifest that does
 * not reproduce is corruption, not a warning.
 */
export async function listShippedSkills(directory: string): Promise<SkillManifest[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const manifests: SkillManifest[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const raw = await readFile(path.join(directory, entry.name, "skill.json"), "utf8");
    const manifest = parseSkillManifest(JSON.parse(raw));
    if (manifest.id !== entry.name) {
      throw new CodepatrolError("STATE_CORRUPT", `Skill manifest id ${manifest.id} does not match its directory ${entry.name}.`);
    }
    const skill = await readFile(path.join(directory, entry.name, "SKILL.md"));
    if (manifest.digest !== skillContentDigest(skill)) {
      throw new CodepatrolError("STATE_CORRUPT", `Skill ${entry.name} digest does not reproduce from SKILL.md.`);
    }
    manifests.push(manifest);
  }
  return manifests.sort((left, right) => left.id.localeCompare(right.id));
}

/**
 * Skills, read back.
 *
 * `list` reports what this installation ships, not workspace state: the
 * skills directory resolves package-relative, no remote is needed, and
 * nothing is written.
 *
 * `resolve <stage>` reports the composition a stage would execute against:
 * the stage skill, its required dependencies, and the available
 * recommendations, with a reason per inclusion and per omission. The command
 * mutates nothing and does not need a workspace.
 *
 * `test <skill-id>` runs the deterministic evaluation harness against the
 * named skill. Every command assertion executes in a throwaway fixture, so
 * the caller's repository is never read or written. The command exits
 * nonzero through `setExitCode` when any scenario is failed or errored.
 */
export const skillCommand: CommandSpec = {
  name: "skill",
  summary: "List the shipped skills with their identity, resolve a stage's composition, or evaluate a skill's protocol suite. Changes nothing.",
  usage: ["skill list", "skill resolve <stage>", "skill test <skill-id>"],
  async run(context, rawArgs) {
    const action = rawArgs[0];
    const args = parseArgs(rawArgs.slice(1), []);
    if (action === "list") {
      exactPositionals(args, 0, "no positional arguments after skill list");
      const skills = (await listShippedSkills(shippedSkillsDirectory)).map(({ id, version, kind, capabilities, digest }) => ({
        id,
        version,
        kind,
        capabilities,
        digest,
      }));
      return { skills };
    }
    if (action === "resolve") {
      const [stage] = args.positionals;
      if (stage === undefined || args.positionals.length !== 1) {
        throw new CodepatrolError("INVALID_ARGUMENT", "skill resolve requires exactly one stage argument.", 2);
      }
      if (!(STAGES as readonly string[]).includes(stage)) {
        throw new CodepatrolError("INVALID_ARGUMENT", `Unknown stage for skill resolve: ${stage}. Expected one of ${STAGES.join(", ")}.`, 2);
      }
      const manifests = await listShippedSkills(shippedSkillsDirectory);
      return resolveComposition(stage as (typeof STAGES)[number], manifests, [...HOST_CAPABILITIES]);
    }
    if (action === "test") {
      const [skillId] = args.positionals;
      if (skillId === undefined || args.positionals.length !== 1) {
        throw new CodepatrolError("INVALID_ARGUMENT", "skill test requires exactly one skill id argument.", 2);
      }
      const manifests = await listShippedSkills(shippedSkillsDirectory);
      const outcome = await runShippedSuite(skillId, manifests);
      if (outcome.summary.failed > 0 || outcome.summary.errored > 0) {
        context.setExitCode?.(1);
      }
      return outcome;
    }
    throw new CodepatrolError("INVALID_ARGUMENT", "skill action must be list, resolve, or test.", 2);
  },
};