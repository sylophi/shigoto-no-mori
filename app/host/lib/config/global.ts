// Per-device global config, in the store: preferences that span every
// project (custom launchers, integrations, …). Appearance is client
// config and lives in main/electron/clientConfig.ts instead. Reads and
// writes go through the engine's Config (host/lib/engineOps.ts), the
// same the terminal's `sm config` uses.
import { errorWordsOf } from "@host/lib/errorWords";
import { log } from "@shared/log";

// Config-change reconcilers. Every change path (the IPC write, and a
// terminal write the store watcher notices) ends in globalConfigChanged,
// so a listener registered here runs on all of them. directConnections
// has no Settings UI (it is toggled through the CLI, which never touches
// the IPC write handler), so this subscriber is what makes EVERY change
// reconcile the direct listener. Host owns the mechanism,
// process/handlers.ts registers the one reconciler.
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
      log.warn(`[config] change listener failed: ${errorWordsOf(error)}`);
    }
  }
}
