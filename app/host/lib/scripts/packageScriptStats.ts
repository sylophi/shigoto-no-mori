// Per-repo usage log and sort preference for the package.json scripts list.
// Same rolling-window algorithm as the launcher row (see ./useLog) so the
// "Most used" sort behaves identically across both features. Stored in the
// global state.json keyed by projectId, since sort and usage are
// app-managed UI state, not the user-editable per-project shigomori config.
import type {
  PackageScriptSortMode,
  PackageScriptUsage,
} from "@shared/schemas";
import { stateStore } from "../config/store";
import { countWithin, maxTimestamp, pruneAndPush } from "../util/useLog";

const USE_LOG_KEY = "packageScriptUseLog";
const SORT_KEY = "packageScriptSort";
const ORDER_KEY = "packageScriptOrder";

type UseLog = Record<string, Record<string, number[]>>;
type SortMap = Record<string, PackageScriptSortMode>;
type OrderMap = Record<string, string[]>;

// "frequent" is the implicit default: new repos open with the most-used
// scripts on top, and switching back to it deletes the persisted entry
// instead of writing it.
const IMPLICIT_MODE: PackageScriptSortMode = "frequent";

export function readScriptSort(projectId: string): PackageScriptSortMode {
  const map = stateStore.readHint<SortMap>(SORT_KEY, {});
  return map[projectId] ?? IMPLICIT_MODE;
}

export function writeScriptSort(
  projectId: string,
  mode: PackageScriptSortMode,
): void {
  // readKey rather than readHint even though readScriptSort above
  // hints: this read feeds the write below, so a fallback to {} would
  // offer up every other repo's sort to be overwritten.
  const map = stateStore.readKey<SortMap>(SORT_KEY, {});
  if (
    map[projectId] === mode ||
    (mode === IMPLICIT_MODE && !(projectId in map))
  ) {
    return;
  }
  if (mode === IMPLICIT_MODE) {
    delete map[projectId];
  } else {
    map[projectId] = mode;
  }
  stateStore.writeKey<SortMap>(SORT_KEY, map);
}

export function readScriptOrder(projectId: string): string[] {
  const map = stateStore.readHint<OrderMap>(ORDER_KEY, {});
  return map[projectId] ?? [];
}

// `arranged` is one worktree's scripts in their new order. Merged here,
// against the stored order read under the lock, rather than by the
// client against its cached copy, which another window may have written
// past.
export function writeScriptOrder(projectId: string, arranged: string[]): void {
  stateStore.updateKey<OrderMap>(ORDER_KEY, {}, (map) => {
    const current = map[projectId] ?? [];
    const next = mergeArrangedOrder(current, arranged);
    const unchanged =
      current.length === next.length &&
      current.every((name, i) => name === next[i]);
    return unchanged ? undefined : { ...map, [projectId]: next };
  });
}

// The stored order after one worktree arranges its scripts. Scripts it
// lacks (another branch's) stay stored, each right behind the nearest
// script it followed that this worktree does have, so "deploy comes
// after dev" survives a branch without deploy moving dev. One with no
// such script before it keeps to the front.
export function mergeArrangedOrder(
  stored: readonly string[],
  arranged: readonly string[],
): string[] {
  const shown = new Set(arranged);
  const followers = new Map<string | null, string[]>();
  let anchor: string | null = null;
  for (const name of stored) {
    if (shown.has(name)) {
      anchor = name;
    } else {
      followers.set(anchor, [...(followers.get(anchor) ?? []), name]);
    }
  }
  return [
    ...(followers.get(null) ?? []),
    ...arranged.flatMap((name) => [name, ...(followers.get(name) ?? [])]),
  ];
}

export function usageFor(
  projectId: string,
  scriptNames: string[],
): Record<string, PackageScriptUsage> {
  const projectLog =
    stateStore.readHint<UseLog>(USE_LOG_KEY, {})[projectId] ?? {};
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
  const log = stateStore.readKey<UseLog>(USE_LOG_KEY, {});
  const projectLog = log[projectId] ?? {};
  projectLog[scriptName] = pruneAndPush(
    projectLog[scriptName] ?? [],
    Date.now(),
  );
  log[projectId] = projectLog;
  stateStore.writeKey<UseLog>(USE_LOG_KEY, log);
}
