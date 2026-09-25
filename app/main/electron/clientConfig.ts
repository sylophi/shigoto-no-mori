// The client config store: clientConfig.json in Electron's userData.
// Client config is how this app instance looks (theme, doubutsu).
// Device config in the shigomori root gates what a machine can do and
// stays with the host and the CLI. This file is owned by the main
// process alone and the CLI never touches it. Seeding from the
// pre-split device config lives in clientConfigMigration.ts, so this
// store stays a pure userData read/write.
//
// Reads are synchronous because the boot path needs the saved theme
// before the BrowserWindow exists (main/index.ts applies it via
// applyThemeSource below, which is what keeps the vibrancy material
// from flashing the wrong variant on first paint).
import { app, nativeTheme } from "electron";
import { join } from "node:path";
import {
  type ClientConfig,
  ClientConfigSchema,
  StoredClientConfigSchema,
  type Theme,
} from "@shared/schemas";
import {
  atomicWriteJson,
  readJsonOrNull,
  readJsonOrNullSync,
  withSchemaVersion,
} from "@host/lib/util/jsonFile";

export function clientConfigPath(): string {
  return join(app.getPath("userData"), "clientConfig.json");
}

// This module is the store's only writer, so a read is valid until the
// next writeClientConfig in this process updates it. An external
// mutation path would need a cache invalidation hook here (the
// invalidateGlobalConfigCache precedent in host/lib/config/global.ts),
// but none exists today.
let memo: ClientConfig | null = null;

// Mirrors noteHintFailure in host/lib/config/store.ts: a store that
// stays broken is hit on every boot and every save, so warn once per
// file per run instead of never (a silent catch turns corruption into
// a default reset with nothing in the console).
const corruptStoreNoted = new Set<string>();

function noteCorruptStore(file: string, error: unknown): void {
  if (corruptStoreNoted.has(file)) return;
  corruptStoreNoted.add(file);
  console.warn(`[clientConfig] ${file} unreadable, falling back:`, error);
}

// Corrupt or unreadable content reads as empty defaults (not as an
// absent file), so a broken store can never block startup and never
// gets silently reseeded over by the migration's absence probe.
function readStoredDoc(): ClientConfig {
  try {
    return (
      readJsonOrNullSync(clientConfigPath(), StoredClientConfigSchema) ?? {}
    );
  } catch (error) {
    noteCorruptStore(clientConfigPath(), error);
    return {};
  }
}

export function readClientConfigSync(): ClientConfig {
  memo ??= readStoredDoc();
  return memo;
}

// Merge-on-write, matching the downgrade-safety rule the device store
// documents: read the on-disk doc loosely, drop only the keys this
// build models, overlay the incoming ones, restamp, write atomically.
// A full replace would erase keys a newer build wrote. Omission of a
// modeled key still clears it (the omit-on-default serialization).
// Corruption merges over {} instead (warned once above), the same
// default reset the read side applies. Async so saves stop blocking
// the main thread. Only the boot read above stays sync. selfWrite is
// about the state watcher over the shigomori root, and this file lives
// outside it.
export async function writeClientConfig(config: ClientConfig): Promise<void> {
  let onDisk: Record<string, unknown>;
  try {
    onDisk =
      (await readJsonOrNull(clientConfigPath(), StoredClientConfigSchema)) ??
      {};
  } catch (error) {
    noteCorruptStore(clientConfigPath(), error);
    onDisk = {};
  }
  const merged: Record<string, unknown> = { ...onDisk };
  for (const key of Object.keys(ClientConfigSchema.shape)) {
    delete merged[key];
  }
  for (const [key, value] of Object.entries(config)) {
    if (value !== undefined) merged[key] = value;
  }
  await atomicWriteJson(clientConfigPath(), withSchemaVersion(merged), {
    selfWrite: false,
  });
  memo = config;
}

// The one place nativeTheme.themeSource is set, and the single home of
// the absent-means-"system" default. Boot and the window module's
// previewTheme both land here. The clientConfig write deliberately does
// not: the renderer's preview effect has always applied the staged
// theme by the time a save lands, so an apply-on-write could only ever
// override the screen with a stale value.
export function applyThemeSource(theme: Theme | undefined): void {
  nativeTheme.themeSource = theme ?? "system";
}
