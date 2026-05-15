// Per-user global config at ~/shigomori[-dev]/config.json. Holds preferences
// that span every project (currently just custom launchers) and is kept
// separate from state.json (runtime data) and from the per-project configs
// at ~/shigomori[-dev]/projects/<projectId>.json.
import { join } from "node:path";
import { type GlobalConfig, GlobalConfigSchema } from "@shared/schemas";
import { atomicWriteJson, readJsonOrNull } from "./jsonFile";
import { shigomoriRoot } from "./paths";

const CACHE_TTL_MS = 5_000;
let cached: { value: GlobalConfig; expires: number } | null = null;

function configPath(): string {
  return join(shigomoriRoot(), "config.json");
}

export async function readGlobalConfig(): Promise<GlobalConfig> {
  const now = Date.now();
  if (cached && cached.expires > now) return cached.value;
  const value = (await readJsonOrNull(configPath(), GlobalConfigSchema)) ?? {};
  cached = { value, expires: now + CACHE_TTL_MS };
  return value;
}

export async function writeGlobalConfig(config: GlobalConfig): Promise<void> {
  await atomicWriteJson(configPath(), GlobalConfigSchema.parse(config));
  cached = null;
}
