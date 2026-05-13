// Read / write shigomori.config.json from a project's root. Reads are cached
// with a short TTL so repeated IPC handlers (launchers, scripts, palette)
// don't re-read and re-parse on every action; the cache is busted on write.
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
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

  const path = join(projectPath, "shigomori.config.json");
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
      throw new Error(`Failed to read shigomori.config.json at ${path}`, {
        cause: error,
      });
    }
  }

  cache.set(projectPath, { value, expires: now + CACHE_TTL_MS });
  return value;
}

export function configPathFor(projectPath: string): string {
  return join(projectPath, "shigomori.config.json");
}

export async function writeShigotoConfig(
  projectPath: string,
  config: ShigotoConfig,
): Promise<void> {
  const validated = ShigotoConfigSchema.parse(config);
  const target = configPathFor(projectPath);
  const temp = `${target}.tmp.${process.pid}.${Date.now()}`;
  const json = `${JSON.stringify(validated, null, 2)}\n`;
  await writeFile(temp, json, "utf8");
  try {
    await rename(temp, target);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
  cache.delete(projectPath);
}
