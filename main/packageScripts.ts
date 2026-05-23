// Read the worktree's package.json scripts and detect which package
// manager to launch them with. Discovery is lockfile-driven (matches
// what corepack / pnpm / bun themselves use to decide).
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathExists } from "./paths";

export type PackageManager = "bun" | "pnpm" | "yarn" | "npm";

// Raw read of `package.json` + the package manager we'd use to run a
// script. The IPC layer enriches this with per-script usage stats before
// handing it to the renderer.
export interface PackageScriptsFileResult {
  scripts: Record<string, string>;
  packageManager: PackageManager;
}

// Lockfiles in priority order: first one that exists wins. Matches
// corepack/pnpm/bun's own resolution order.
const LOCKFILE_MAP: Array<{ file: string; manager: PackageManager }> = [
  { file: "bun.lockb", manager: "bun" },
  { file: "bun.lock", manager: "bun" },
  { file: "pnpm-lock.yaml", manager: "pnpm" },
  { file: "yarn.lock", manager: "yarn" },
];

export async function detectPackageManager(
  cwd: string,
): Promise<PackageManager> {
  const hits = await Promise.all(
    LOCKFILE_MAP.map((l) => pathExists(join(cwd, l.file))),
  );
  const idx = hits.findIndex(Boolean);
  return idx >= 0 ? LOCKFILE_MAP[idx].manager : "npm";
}

export async function readPackageScripts(
  cwd: string,
): Promise<PackageScriptsFileResult | null> {
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
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function buildScriptCommand(
  pkgManager: PackageManager,
  scriptName: string,
): string {
  return `${pkgManager} run ${shellQuote(scriptName)}`;
}
