// Port-pool integration detection. The user's port-pool tool keeps its
// config at <project-or-worktree-root>/port-pool.config.json. We
// activate the integration when the global toggle is on AND the file
// parses as JSON with a recognizable schemaVersion field. Richer
// validation is left to port-pool itself.
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

let installedCache: { value: boolean; expires: number } | null = null;
const INSTALLED_CACHE_TTL_MS = 30_000;

export async function isPortPoolInstalled(): Promise<boolean> {
  const now = Date.now();
  if (installedCache && installedCache.expires > now) {
    return installedCache.value;
  }
  let installed: boolean;
  try {
    // Use the same which-based probe that launcher detection uses. The
    // user's PATH is patched at startup from their login shell profile,
    // so any globally installed port-pool binary will be found here.
    await execFileP("which", ["port-pool"]);
    installed = true;
  } catch {
    installed = false;
  }
  installedCache = { value: installed, expires: now + INSTALLED_CACHE_TTL_MS };
  return installed;
}

export function clearPortPoolInstalledCache(): void {
  installedCache = null;
}

export async function isPortPoolConfigured(cwd: string): Promise<boolean> {
  let raw: string;
  try {
    raw = await readFile(join(cwd, "port-pool.config.json"), "utf8");
  } catch {
    return false;
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return "schemaVersion" in parsed;
  } catch {
    return false;
  }
}
