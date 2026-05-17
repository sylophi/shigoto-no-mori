// Port-pool integration detection. The user's port-pool tool keeps its
// config at <project-or-worktree-root>/port-pool.config.json. We
// activate the integration when the global toggle is on AND the file
// parses as JSON with a recognizable schemaVersion field. Richer
// validation is left to port-pool itself.
import { readFile } from "node:fs/promises";
import { join } from "node:path";

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
