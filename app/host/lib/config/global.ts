// Per-device global config, in the store: preferences that span every
// project (custom launchers, integrations, …). Appearance is client
// config and lives in main/electron/clientConfig.ts instead. Reads and
// writes go through the engine's Config (host/lib/engineCalls.ts), the
// same the terminal's `sm config` uses.
import { errorMessageOf } from "@shigomori/contracts/errors";
import { createLimiter } from "@shared/util/limit";
import type { GlobalConfig } from "@shigomori/contracts/schemas";
import * as EngineCalls from "@host/lib/engineCalls";
import { log } from "@shared/log";

// The stored document, no defaults filled in: each reader applies its
// own, as it always has.
export function readGlobalConfig(): Promise<GlobalConfig> {
  return EngineCalls.readGlobalConfig();
}

// INVARIANT: every host-side global-config write runs its whole
// read-modify-write under this lock. Today that is the
// `writeDeviceSettings` patch handler, which serves this window's save
// and every peer's, so two saves cannot interleave and lose an update.
const configWriteQueue = createLimiter(1);
export function withGlobalConfigWriteLock<T>(
  task: () => Promise<T>,
): Promise<T> {
  // The limiter frees its slot after a rejected task too, so one failure
  // does not wedge later writes. The caller still sees the rejection.
  return configWriteQueue(task);
}

// Config-change reconcilers. Every change path (the IPC write, and a
// terminal write the store watcher notices) ends in globalConfigChanged,
// so a listener registered here runs on all of them. directConnections
// has no Settings UI (it is toggled through the CLI, which never touches
// the IPC write handler), so this subscriber is what makes EVERY change
// reconcile the direct listener. Host owns the mechanism, main
// registers the one reconciler.
type ConfigChangeListener = () => void;
const configChangeListeners = new Set<ConfigChangeListener>();

export function onGlobalConfigChange(
  listener: ConfigChangeListener,
): () => void {
  configChangeListeners.add(listener);
  return () => configChangeListeners.delete(listener);
}

export function globalConfigChanged(): void {
  for (const listener of configChangeListeners) {
    try {
      listener();
    } catch (error) {
      log.warn(`[config] change listener failed: ${errorMessageOf(error)}`);
    }
  }
}
