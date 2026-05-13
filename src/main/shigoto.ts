// Read shigoto.json from a project's root, with a short TTL cache so repeated
// IPC handlers (launchers, scripts, palette) don't re-read and re-parse on
// every action.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type ShigotoConfig, ShigotoConfigSchema } from "@shared/schemas";

const CACHE_TTL_MS = 5_000;
const cache = new Map<
  string,
  { value: ShigotoConfig | null; expires: number }
>();

export async function readShigotoConfig(
  projectPath: string,
): Promise<ShigotoConfig | null> {
  const now = Date.now();
  const cached = cache.get(projectPath);
  if (cached && cached.expires > now) return cached.value;

  const path = join(projectPath, "shigoto.json");
  let value: ShigotoConfig | null;
  try {
    const raw = await readFile(path, "utf8");
    value = ShigotoConfigSchema.parse(JSON.parse(raw));
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      value = null;
    } else {
      // Don't cache failures — bad config should error every time so the user
      // notices and fixes it.
      throw new Error(`Failed to read shigoto.json at ${path}`, {
        cause: error,
      });
    }
  }

  cache.set(projectPath, { value, expires: now + CACHE_TTL_MS });
  return value;
}
