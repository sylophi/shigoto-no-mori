// Per-repo usage log and sort preference for the package.json scripts list.
// Mirrors the launcher's 14-day rolling-window algorithm so "frequent" sort
// behaves identically across both features. Stored in the global state.json
// keyed by projectId — sort and usage are app-managed UI state, not the
// user-editable per-project shigomori config.
import type {
  PackageScriptSortMode,
  PackageScriptUsage,
} from "@shared/schemas";
import { readKey, writeKey } from "./store";

const USE_LOG_KEY = "packageScriptUseLog";
const SORT_KEY = "packageScriptSort";
const WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

type UseLog = Record<string, Record<string, number[]>>;
type SortMap = Record<string, PackageScriptSortMode>;

export function readScriptSort(projectId: string): PackageScriptSortMode {
  const map = readKey<SortMap>(SORT_KEY, {});
  return map[projectId] ?? "default";
}

export function writeScriptSort(
  projectId: string,
  mode: PackageScriptSortMode,
): void {
  const map = readKey<SortMap>(SORT_KEY, {});
  if (mode === "default") {
    if (!(projectId in map)) return;
    delete map[projectId];
  } else {
    map[projectId] = mode;
  }
  writeKey<SortMap>(SORT_KEY, map);
}

export function usageFor(
  projectId: string,
  scriptNames: string[],
): Record<string, PackageScriptUsage> {
  const log = readKey<UseLog>(USE_LOG_KEY, {});
  const projectLog = log[projectId] ?? {};
  const now = Date.now();
  const cutoff = now - WINDOW_MS;
  const out: Record<string, PackageScriptUsage> = {};
  for (const name of scriptNames) {
    const timestamps = projectLog[name] ?? [];
    let last = 0;
    let recent = 0;
    for (const t of timestamps) {
      if (t > last) last = t;
      if (t >= cutoff) recent++;
    }
    out[name] = { lastUsed: last, recentCount: recent };
  }
  return out;
}

export function bumpScriptUseCount(
  projectId: string,
  scriptName: string,
): void {
  const log = readKey<UseLog>(USE_LOG_KEY, {});
  const now = Date.now();
  const cutoff = now - WINDOW_MS;
  const projectLog = log[projectId] ?? {};
  // Keep entries that contribute to either the recent-window count or the
  // "most recently used" tiebreaker. The newest timestamp always stays.
  const previous = projectLog[scriptName] ?? [];
  const fresh = previous.filter((t) => t >= cutoff);
  fresh.push(now);
  projectLog[scriptName] = fresh;
  log[projectId] = projectLog;
  writeKey<UseLog>(USE_LOG_KEY, log);
}
