// Per-device global config at <dataDir>/config.json. Holds
// preferences that span every project (custom launchers, integrations, …)
// and is kept separate from registry.json (projects, shelf), state.json
// (use logs, sort and collapse preferences) and the per-project configs
// at <dataDir>/projects/<projectId>.json. Appearance is client
// config and lives in main/electron/clientConfig.ts instead. The CLI
// owns the file: reads go through `sm config read` and writes through
// `sm config write` (host/ipc/cliDelegate.ts). The one-time drains at
// the bottom are the exception, sync on the boot path.
import { z } from "zod";
import { join } from "node:path";
import { errorMessageOf } from "@shared/errors";
import { createLimiter } from "@shared/util/limit";
import {
  type ClientConfig,
  ClientConfigSchema,
  type GlobalConfig,
  StoredGlobalConfigSchema,
} from "@shared/schemas";
import { globalConfigReadViaCli } from "@host/ipc/cliDelegate";
import {
  atomicWriteJsonSync,
  readJsonOrNullSync,
  withSchemaVersion,
} from "../util/jsonFile";
import { withFileLock } from "../util/lockFile";
import { CONFIG_FILE, dataDir } from "../util/paths";
import { ttlValueCache } from "../util/ttlCache";

function configPath(): string {
  return join(dataDir(), CONFIG_FILE);
}

// The stored document, no defaults filled in: each reader applies its
// own, as it always has.
const cache = ttlValueCache<GlobalConfig>(5_000, globalConfigReadViaCli);

export async function readGlobalConfig(): Promise<GlobalConfig> {
  return cache.get();
}

// Cache-bypassing read for a read-modify-write base. Drops the TTL entry
// and reads through the CLI again, then refreshes the cache with it.
// INVARIANT: the device-settings patch write MUST base itself on this,
// never on the 5s-TTL readGlobalConfig, because it hands the CLI a whole
// document and the CLI clears every registered key the payload omits
// (see globalConfigWriteViaCli). A base up to the TTL stale would write
// back a value a CLI `set` just changed, as authoritative. Unlike
// invalidateGlobalConfigCache this fires no change listeners: it is a
// read, not a config change.
export async function readGlobalConfigFresh(): Promise<GlobalConfig> {
  cache.invalidate();
  return cache.get();
}

// INVARIANT: every async host-side global-config write runs its whole
// read-modify-write under this lock. Today that is the
// `writeDeviceSettings` patch handler, which serves this window's save
// and every peer's, so two saves cannot interleave and lose an update.
// The CLI's file lock serializes across processes, this serializes the
// in-process read-then-write window the file lock cannot see:
// writeDeviceSettings reads a fresh base and then writes the whole
// document. The sync boot drains below run before the first window.
const configWriteQueue = createLimiter(1);
export function withGlobalConfigWriteLock<T>(
  task: () => Promise<T>,
): Promise<T> {
  // The limiter frees its slot after a rejected task too, so one failure
  // does not wedge later writes. The caller still sees the rejection.
  return configWriteQueue(task);
}

// Config-change reconcilers. Every change path (the IPC write, an
// external CLI write picked up by the state watcher, and nuke wiping
// config.json) drops the cache through invalidateGlobalConfigCache, so
// a listener registered here runs on all of them. directConnections has
// no Settings UI (it is toggled by editing config.json or the CLI,
// which never touch the IPC write handler), so this subscriber is what
// makes EVERY change reconcile the direct listener, nuke included.
// Host owns the mechanism, main registers the one reconciler.
type ConfigChangeListener = () => void;
const configChangeListeners = new Set<ConfigChangeListener>();

export function onGlobalConfigChange(
  listener: ConfigChangeListener,
): () => void {
  configChangeListeners.add(listener);
  return () => configChangeListeners.delete(listener);
}

// For callers that delete config.json out from under the cache (nuke):
// without this, reads for up to the TTL would keep serving the wiped
// preferences as if the nuke hadn't happened. Also fans the change out
// to every subscriber so downstream state (the direct listener)
// reconciles no matter which path changed config.
export function invalidateGlobalConfigCache(): void {
  cache.invalidate();
  for (const listener of configChangeListeners) {
    try {
      listener();
    } catch (error) {
      console.warn(`[config] change listener failed: ${errorMessageOf(error)}`);
    }
  }
}

// One locked read-mutate-write of config.json for the drains: `mutate`
// edits the parsed doc in place and says whether it changed anything,
// and only a change is written back (schemaVersion restamped) and
// invalidates the cache. Runs under the same sibling
// .lock the CLI's updateConfigDoc takes (cli/cmd_config.go,
// host/lib/util/lockFile.ts), so app and CLI writes exclude each
// other. Sync because two callers sit on the boot path before the
// first window. Returns false when config.json is missing.
function updateConfigDocSync(
  mutate: (doc: z.infer<typeof StoredGlobalConfigSchema>) => boolean,
): boolean {
  const path = configPath();
  return withFileLock(`${path}.lock`, () => {
    const doc = readJsonOrNullSync(path, StoredGlobalConfigSchema);
    if (doc === null || !mutate(doc)) return false;
    // Owner-only, like the CLI's writes of this file (cli/state.go
    // configFileMode).
    atomicWriteJsonSync(path, withSchemaVersion(doc), { mode: 0o600 });
    cache.invalidate();
    return true;
  });
}

// One-shot drain of the removed LAN listener's keys out of config.json:
// `socketHost` (its settings and bearer token) and `remoteDevices` (an
// older client's per-host tokens). Nothing reads either anymore, but an
// old config may still carry them in plaintext, and both writers
// preserve keys they don't manage (the CLI's merge only clears
// registered keys, the settings patch spreads the stored document), so
// an explicit delete is the only thing that ever removes them. Runs
// every boot, and reads without writing when neither key is present.
export function dropRemovedLanKeys(): void {
  updateConfigDocSync((doc) => {
    if (!("socketHost" in doc) && !("remoteDevices" in doc)) return false;
    delete doc["socketHost"];
    delete doc["remoteDevices"];
    return true;
  });
}

// The pre-split appearance keys in config.json, for the client config
// migration (main/electron/clientConfigMigration.ts): read first, so a
// failed store write loses nothing, then dropped once the store holds
// them. Throws when config.json is unreadable, and the caller skips
// the migration for that boot.
export function readLegacyAppearance(): ClientConfig {
  const doc = readJsonOrNullSync(configPath(), StoredGlobalConfigSchema);
  const found: ClientConfig = {};
  if (doc === null) return found;
  // Field by field so one bad value can't void the other. An invalid
  // value is still drained by dropLegacyAppearance: the store's
  // defaults are the right replacement for a value no build could read.
  const theme = ClientConfigSchema.shape.theme.safeParse(doc["theme"]);
  if (theme.success && theme.data !== undefined) found.theme = theme.data;
  const doubutsu = ClientConfigSchema.shape.doubutsu.safeParse(doc["doubutsu"]);
  if (doubutsu.success && doubutsu.data !== undefined) {
    found.doubutsu = doubutsu.data;
  }
  return found;
}

// The drain half, run once the values are safely in the client store.
// Nothing to delete means nothing to write: a fresh install's
// config.json passes through untouched.
export function dropLegacyAppearance(): void {
  updateConfigDocSync((doc) => {
    if (!("theme" in doc) && !("doubutsu" in doc)) return false;
    delete doc["theme"];
    delete doc["doubutsu"];
    return true;
  });
}
