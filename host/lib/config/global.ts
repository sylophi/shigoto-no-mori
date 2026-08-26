// Per-device global config at ~/shigomori[-dev]/config.json. Holds
// preferences that span every project (custom launchers, integrations, …)
// and is kept separate from registry.json (projects, shelf), state.json
// (use logs, sort and collapse preferences) and the per-project configs
// at ~/shigomori[-dev]/projects/<projectId>.json. Appearance is client
// config and lives in main/electron/clientConfig.ts instead.
import { join } from "node:path";
import {
  type ClientConfig,
  ClientConfigSchema,
  type GlobalConfig,
  StoredGlobalConfigSchema,
} from "@shared/schemas";
import {
  atomicWriteJsonSync,
  readJsonOrNull,
  readJsonOrNullSync,
  withSchemaVersion,
} from "../util/jsonFile";
import { withFileLock } from "../util/lockFile";
import { shigomoriRoot } from "../util/paths";
import { ttlValueCache } from "../util/ttlCache";

function configPath(): string {
  return join(shigomoriRoot(), "config.json");
}

const cache = ttlValueCache<GlobalConfig>(
  5_000,
  async () =>
    (await readJsonOrNull(configPath(), StoredGlobalConfigSchema)) ?? {},
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

// One-shot drain of the pre-split appearance keys out of config.json,
// for the client config migration (main/electron/clientConfigMigration.ts).
// Extracts theme and doubutsu, deletes them from the doc, writes it
// back with every other key intact and schemaVersion restamped, and
// returns what it found. Runs under the same sibling .lock the CLI's
// updateConfigDoc takes (cli/cmd_config.go, host/lib/util/lockFile.ts),
// so app and CLI writes exclude each other. Sync because the caller
// sits on the boot path before the first window. Throws when
// config.json is unreadable, and the caller skips the drain for that
// boot.
export function takeLegacyAppearance(): ClientConfig {
  const path = configPath();
  return withFileLock(`${path}.lock`, () => {
    const doc = readJsonOrNullSync(path, StoredGlobalConfigSchema);
    if (doc === null) return {};
    const taken: ClientConfig = {};
    // Field by field so one bad value can't void the other. An invalid
    // value is still drained below: the store's defaults are the right
    // replacement for a value no build could read.
    const theme = ClientConfigSchema.shape.theme.safeParse(doc["theme"]);
    if (theme.success && theme.data !== undefined) taken.theme = theme.data;
    const doubutsu = ClientConfigSchema.shape.doubutsu.safeParse(
      doc["doubutsu"],
    );
    if (doubutsu.success && doubutsu.data !== undefined) {
      taken.doubutsu = doubutsu.data;
    }
    // Nothing to delete means nothing to write: a fresh install's
    // config.json passes through untouched.
    if (!("theme" in doc) && !("doubutsu" in doc)) return taken;
    delete doc["theme"];
    delete doc["doubutsu"];
    atomicWriteJsonSync(path, withSchemaVersion(doc));
    cache.invalidate();
    return taken;
  });
}
