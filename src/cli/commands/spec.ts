import { exactPositionals, parseArgs, readJsonFile, requiredFlag } from "../args.js";
import type { CommandSpec } from "../command.js";
import { publish, published } from "../command.js";
import { CodepatrolError } from "../../core/errors.js";
import { parseInitiativeDocument } from "../../core/initiative-document.js";

/**
 * The Core half of Spec.
 *
 * Reading an intent and writing an Initiative document is the skill's job, so
 * the CLI exposes only the three things that must be deterministic: what the
 * graph currently is, whether a document is legal against it, and applying it.
 */
export const specCommand: CommandSpec = {
  name: "spec",
  summary: "Inspect the Work graph and apply a validated Initiative document.",
  usage: [
    "spec inspect",
    "spec validate --initiative <document.json>",
    "spec apply --initiative <document.json>",
  ],
  async run(context, rawArgs) {
    const action = rawArgs[0];
    const args = parseArgs(rawArgs.slice(1), action === "inspect" ? [] : ["initiative"]);
    exactPositionals(args, 0, `no positional arguments after spec ${action ?? "<action>"}`);
    if (action === "inspect") return context.spec.inspect();
    if (action === "validate" || action === "apply") {
      const document = parseInitiativeDocument(await readJsonFile(context.workspace, requiredFlag(args, "initiative")));
      if (action === "validate") return context.spec.validate(document);
      const applied = await context.spec.apply(document);
      return published(applied, await publish(context));
    }
    throw new CodepatrolError("INVALID_ARGUMENT", "spec action must be inspect, validate, or apply.", 2);
  },
};
