// Per-repo usage log and sort preference for the package.json scripts list.
// Same rolling-window algorithm as the launcher row (see ./useLog) so the
// "Most used" sort behaves identically across both features. Stored in the
// global state.json keyed by projectId — sort and usage are app-managed UI
// state, not the user-editable per-project shigomori config.
import type {
  PackageScriptSortMode,
  PackageScriptUsage,
} from "@shared/schemas";
import { readKey, writeKey } from "./store";
import { countWithin, maxTimestamp, pruneAndPush } from "./useLog";

const USE_LOG_KEY = "packageScriptUseLog";
const SORT_KEY = "packageScriptSort";

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
  if (map[projectId] === mode || (mode === "default" && !(projectId in map))) {
    return;
  }
  if (mode === "default") {
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
  const projectLog = readKey<UseLog>(USE_LOG_KEY, {})[projectId] ?? {};
  const now = Date.now();
  const out: Record<string, PackageScriptUsage> = {};
  for (const name of scriptNames) {
    const timestamps = projectLog[name] ?? [];
    out[name] = {
      lastUsed: maxTimestamp(timestamps),
      recentCount: countWithin(timestamps, now),
    };
  }
  return out;
}

export function bumpScriptUseCount(
  projectId: string,
  scriptName: string,
): void {
  const log = readKey<UseLog>(USE_LOG_KEY, {});
  const projectLog = log[projectId] ?? {};
  projectLog[scriptName] = pruneAndPush(
    projectLog[scriptName] ?? [],
    Date.now(),
  );
  log[projectId] = projectLog;
  writeKey<UseLog>(USE_LOG_KEY, log);
}
