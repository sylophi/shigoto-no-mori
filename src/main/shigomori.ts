// Per-project config lives under ~/shigomori[-dev]/projects/<projectId>.json.
// Shigomori manages these itself; we don't touch the user's repo.
import { join } from "node:path";
import { type ShigomoriConfig, ShigomoriConfigSchema } from "@shared/schemas";
import { atomicWriteJson, readJsonOrNull } from "./jsonFile";
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
  const hit = cache.get(projectId);
  if (hit && hit.expires > now) return hit.value;
  // Failures aren't cached — a bad config should error every read so the
  // user notices and fixes it.
  const value = await readJsonOrNull(configPathFor(projectId), ShigomoriConfigSchema);
  cache.set(projectId, { value, expires: now + CACHE_TTL_MS });
  return value;
}

export async function writeShigomoriConfig(
  projectId: string,
  config: ShigomoriConfig,
): Promise<void> {
  await atomicWriteJson(
    configPathFor(projectId),
    ShigomoriConfigSchema.parse(config),
  );
  cache.delete(projectId);
}
