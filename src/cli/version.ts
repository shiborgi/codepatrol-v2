import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The CLI is the only layer allowed to read the manifest; core and application stay filesystem-free.
const manifestPath = path.resolve(fileURLToPath(import.meta.url), "../../../package.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { version?: unknown };

if (typeof manifest.version !== "string" || manifest.version === "") {
  throw new Error(`Missing version in ${manifestPath}.`);
}

export const VERSION: string = manifest.version;
