// Per-project config lives under ~/shigomori[-dev]/projects/<projectId>.json.
// Shigomori manages these itself; we don't touch the user's repo.
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type ShigomoriConfig, ShigomoriConfigSchema } from "@shared/schemas";
import { shigomoriRoot } from "./paths";

const CACHE_TTL_MS = 5_000;
const cache = new Map<
  string,
  { value: ShigomoriConfig | null; expires: number }
>();

function configPathFor(projectId: string): string {
  return join(shigomoriRoot(), "projects", `${projectId}.json`);
}

export async function readShigomoriConfig(
  projectId: string,
): Promise<ShigomoriConfig | null> {
  const now = Date.now();
  const cached = cache.get(projectId);
  if (cached && cached.expires > now) return cached.value;

  const path = configPathFor(projectId);
  let value: ShigomoriConfig | null;
  try {
    const raw = await readFile(path, "utf8");
    value = ShigomoriConfigSchema.parse(JSON.parse(raw));
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
      throw new Error(`Failed to read project config at ${path}`, {
        cause: error,
      });
    }
  }

  cache.set(projectId, { value, expires: now + CACHE_TTL_MS });
  return value;
}

export async function writeShigomoriConfig(
  projectId: string,
  config: ShigomoriConfig,
): Promise<void> {
  const validated = ShigomoriConfigSchema.parse(config);
  const target = configPathFor(projectId);
  await mkdir(dirname(target), { recursive: true });
  const temp = `${target}.tmp.${process.pid}.${Date.now()}`;
  const json = `${JSON.stringify(validated, null, 2)}\n`;
  await writeFile(temp, json, "utf8");
  try {
    await rename(temp, target);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
  cache.delete(projectId);
}
