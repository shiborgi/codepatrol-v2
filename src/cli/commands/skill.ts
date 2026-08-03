import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { exactPositionals, parseArgs } from "../args.js";
import type { CommandSpec } from "../command.js";
import { CodepatrolError } from "../../core/errors.js";
import { parseSkillManifest, skillContentDigest, type SkillManifest } from "../../core/skill.js";

// The CLI is the only layer allowed to read the filesystem; core stays pure.
const shippedSkillsDirectory = path.resolve(fileURLToPath(import.meta.url), "../../../../skills");

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
 * Reports what this installation ships, not workspace state: the skills
 * directory resolves package-relative, no remote is needed, and nothing is
 * written.
 */
export const skillCommand: CommandSpec = {
  name: "skill",
  summary: "List the shipped skills with their identity. Changes nothing.",
  usage: ["skill list"],
  async run(_context, rawArgs) {
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
    throw new CodepatrolError("INVALID_ARGUMENT", "skill action must be list.", 2);
  },
};
