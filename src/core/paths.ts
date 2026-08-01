import { manifestPath } from "./work-manifest.js";

function normalized(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

export function isReservedPath(path: string): boolean {
  const value = normalized(path);
  return value === ".codepatrol" || value.startsWith(".codepatrol/");
}

export function executorReservedOffenders(paths: readonly string[]): string[] {
  return [...new Set(paths.map(normalized).filter(isReservedPath))].sort();
}

export function integrationReservedOffenders(paths: readonly string[], workId: string): string[] {
  const allowed = manifestPath(workId);
  return [...new Set(paths.map(normalized).filter((path) => isReservedPath(path) && path !== allowed))].sort();
}
