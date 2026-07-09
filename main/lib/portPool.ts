// Port-pool integration detection. The user's port-pool tool keeps its
// config at <project-or-worktree-root>/port-pool.config.json. We
// activate the integration when the global toggle is on AND the file
// parses as JSON with a recognizable schemaVersion field. Richer
// validation is left to port-pool itself.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { binaryOnPath } from "./util/binaries";
import { isWindows } from "./util/platform";
import { ttlValueCache } from "./util/ttlCache";

const INSTALLED_CACHE_TTL_MS = 30_000;

const installedCache = ttlValueCache(INSTALLED_CACHE_TTL_MS, () =>
  binaryOnPath("port-pool"),
);

// port-pool ships for macOS only; short-circuit rather than probing so
// the integration can never half-activate on Windows.
export function isPortPoolInstalled(): Promise<boolean> {
  if (isWindows) return Promise.resolve(false);
  return installedCache.get();
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
