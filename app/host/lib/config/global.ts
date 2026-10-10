// Per-device global config, in the store: preferences that span every
// project (custom launchers, integrations, …). Appearance is client
// config and lives in main/electron/clientConfig.ts instead. Reads and
// writes go through the engine's Config (host/lib/engineOps.ts), the
// same the terminal's `sm config` uses.
import { errorMessageOf } from "@shigomori/contracts/errors";
import * as Semaphore from "effect/Semaphore";
import { log } from "@shared/log";

// INVARIANT: every host-side global-config write runs its whole
// read-modify-write under this lock. Today that is the
// `writeDeviceSettings` patch handler, which serves this window's save
// and every peer's, so two saves cannot interleave and lose an update.
export const globalConfigWrites = Semaphore.makeUnsafe(1);

// Config-change reconcilers. Every change path (the IPC write, and a
// terminal write the store watcher notices) ends in globalConfigChanged,
// so a listener registered here runs on all of them. directConnections
// has no Settings UI (it is toggled through the CLI, which never touches
// the IPC write handler), so this subscriber is what makes EVERY change
// reconcile the direct listener. Host owns the mechanism, process/impls.ts
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
