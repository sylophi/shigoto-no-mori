// Per-user global config at ~/shigomori[-dev]/config.json. Holds preferences
// that span every project (custom launchers, theme, …) and is kept separate
// from state.json (runtime data) and from the per-project configs at
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

// Sync reads used by the main process at window-create time, where
// async IO would race the BrowserWindow constructor. Any read/parse
// failure falls back to the field's default so a corrupt config can
// never block startup.
function readConfigFieldSync(field: string): unknown {
  try {
    const raw = readFileSync(configPath(), "utf8");
    return (JSON.parse(raw) as Record<string, unknown>)[field];
  } catch {
    return undefined;
  }
}

export function readThemeSync(): Theme {
  const parsed = ThemeSchema.safeParse(readConfigFieldSync("theme"));
  return parsed.success ? parsed.data : "system";
}

// Doubutsu mode: absent = on (the default), explicit false is the
// opt-out, anything unreadable = on.
export function readDoubutsuSync(): boolean {
  const value = readConfigFieldSync("doubutsu");
  return typeof value === "boolean" ? value : true;
}
