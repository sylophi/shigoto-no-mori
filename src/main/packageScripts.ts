// Read the worktree's package.json scripts and detect which package
// manager to launch them with. Discovery is lockfile-driven (matches
// what corepack / pnpm / bun themselves use to decide).
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

export type PackageManager = "bun" | "pnpm" | "yarn" | "npm";

export interface PackageScriptsResult {
  scripts: Record<string, string>;
  packageManager: PackageManager;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function detectPackageManager(
  cwd: string,
): Promise<PackageManager> {
  if (
    (await fileExists(join(cwd, "bun.lockb"))) ||
    (await fileExists(join(cwd, "bun.lock")))
  ) {
    return "bun";
  }
  if (await fileExists(join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (await fileExists(join(cwd, "yarn.lock"))) return "yarn";
  return "npm";
}

export async function readPackageScripts(
  cwd: string,
): Promise<PackageScriptsResult | null> {
  let raw: string;
  try {
    raw = await readFile(join(cwd, "package.json"), "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const scripts =
    parsed &&
    typeof parsed === "object" &&
    "scripts" in parsed &&
    parsed.scripts &&
    typeof parsed.scripts === "object"
      ? (parsed.scripts as Record<string, unknown>)
      : {};
  const cleanScripts: Record<string, string> = {};
  for (const [name, value] of Object.entries(scripts)) {
    if (typeof value === "string") cleanScripts[name] = value;
  }
  const packageManager = await detectPackageManager(cwd);
  return { scripts: cleanScripts, packageManager };
}

// All four package managers accept `<mgr> run <name>`. The bare alias
// (`bun <name>`, `pnpm <name>`) works too for non-reserved names, but
// `run` is unambiguous and matches what users normally type.
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function buildScriptCommand(
  pkgManager: PackageManager,
  scriptName: string,
): string {
  return `${pkgManager} run ${shellQuote(scriptName)}`;
}
