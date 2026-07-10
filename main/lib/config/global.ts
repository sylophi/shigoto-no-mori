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
import { atomicWriteJson, readJsonOrNull } from "../util/jsonFile";
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

export async function writeGlobalConfig(config: GlobalConfig): Promise<void> {
  await atomicWriteJson(configPath(), GlobalConfigSchema.parse(config));
  cache.invalidate();
}

// Sync read used by the main process at window-create time, where async
// IO would race the BrowserWindow constructor. Any parse failure falls
// back to "system" so a corrupt config can never block startup.
export function readThemeSync(): Theme {
  try {
    const raw = readFileSync(configPath(), "utf8");
    const parsed = ThemeSchema.safeParse(
      (JSON.parse(raw) as { theme?: unknown }).theme,
    );
    return parsed.success ? parsed.data : "system";
  } catch {
    return "system";
  }
}

// Same window-create-time idiom for doubutsu mode: absent = on (the
// default), explicit false is the opt-out, anything unreadable = on.
export function readDoubutsuSync(): boolean {
  try {
    const raw = readFileSync(configPath(), "utf8");
    const value = (JSON.parse(raw) as { doubutsu?: unknown }).doubutsu;
    return typeof value === "boolean" ? value : true;
  } catch {
    return true;
  }
}
