// Per-project config lives under ~/shigomori[-dev]/projects/<projectId>.json.
// Shigomori manages these itself; we don't touch the user's repo.
import { join } from "node:path";
import { type ShigomoriConfig, ShigomoriConfigSchema } from "@shared/schemas";
import { atomicWriteJson, readJsonOrNull } from "./jsonFile";
import { shigomoriRoot } from "./paths";
import { ttlMapCache } from "./ttlCache";

function configPathFor(projectId: string): string {
  return join(shigomoriRoot(), "projects", `${projectId}.json`);
}

// Failures aren't cached -- a bad config should error every read so the
// user notices and fixes it.
const cache = ttlMapCache<string, ShigomoriConfig | null>(5_000, (projectId) =>
  readJsonOrNull(configPathFor(projectId), ShigomoriConfigSchema),
);

export async function readShigomoriConfig(
  projectId: string,
): Promise<ShigomoriConfig | null> {
  return cache.get(projectId);
}

export async function writeShigomoriConfig(
  projectId: string,
  config: ShigomoriConfig,
): Promise<void> {
  await atomicWriteJson(
    configPathFor(projectId),
    ShigomoriConfigSchema.parse(config),
  );
  cache.invalidate(projectId);
}
