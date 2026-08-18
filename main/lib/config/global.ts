// Per-user global config at ~/shigomori[-dev]/config.json. Holds preferences
// that span every project (custom launchers, theme, …) and is kept separate
// from registry.json (projects, shelf), state.json (use logs, sort and
// collapse preferences) and the per-project configs at
// ~/shigomori[-dev]/projects/<projectId>.json.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type GlobalConfig,
  GlobalConfigSchema,
  type Theme,
  ThemeSchema,
} from "@shared/schemas";
import { readJsonOrNull } from "../util/jsonFile";
import { shigomoriRoot } from "../util/paths";
import { ttlValueCache } from "../util/ttlCache";

function configPath(): string {
  return join(shigomoriRoot(), "config.json");
}

const cache = ttlValueCache<GlobalConfig>(
  5_000,
  async () => (await readJsonOrNull(configPath(), GlobalConfigSchema)) ?? {},
);

export async function readGlobalConfig(): Promise<GlobalConfig> {
  return cache.get();
}

// For callers that delete config.json out from under the cache (nuke):
// without this, reads for up to the TTL would keep serving the wiped
// preferences as if the nuke hadn't happened.
export function invalidateGlobalConfigCache(): void {
  cache.invalidate();
}

// Sync read used by the main process at window-create time, where
// async IO would race the BrowserWindow constructor. Any read/parse
// failure falls back to the default so a corrupt config can never
// block startup.
export function readThemeSync(): Theme {
  try {
    const raw = readFileSync(configPath(), "utf8");
    const value = (JSON.parse(raw) as Record<string, unknown>)["theme"];
    const parsed = ThemeSchema.safeParse(value);
    return parsed.success ? parsed.data : "system";
  } catch {
    return "system";
  }
}
