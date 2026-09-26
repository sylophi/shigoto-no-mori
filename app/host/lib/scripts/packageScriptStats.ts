// Per-repo sort preference, manual order and launch-row picks for the
// package.json scripts list, app-managed UI state stored in the global
// state.json keyed by projectId (not the user-editable per-project
// config). The use log the "Most used" sort ranks by is the CLI's:
// `sm run` counts every run and reports the stats with the list.
import type { PackageScriptSortMode } from "@shared/schemas";
import { withLaunchRowScript } from "@shared/launchRow";
import { stateStore } from "../config/store";

const SORT_KEY = "packageScriptSort";
const ORDER_KEY = "packageScriptOrder";
const LAUNCH_ROW_KEY = "packageScriptLaunchRow";

type SortMap = Record<string, PackageScriptSortMode>;
type OrderMap = Record<string, string[]>;
type LaunchRowMap = Record<string, string[]>;

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

// The scripts put on the launch row by hand, which the row limits itself
// to under the "manual" sort. Project-wide like the order, so it can
// name scripts a given worktree lacks. Empty means none were picked.
export function readLaunchRow(projectId: string): string[] {
  const map = stateStore.readHint<LaunchRowMap>(LAUNCH_ROW_KEY, {});
  return map[projectId] ?? [];
}

// One script on or off the row, applied under the lock rather than as a
// whole list from the client, so two windows picking different scripts
// both land. Dropping the last one deletes the project's entry.
export function writeLaunchRowScript(
  projectId: string,
  scriptName: string,
  onRow: boolean,
): void {
  stateStore.updateKey<LaunchRowMap>(LAUNCH_ROW_KEY, {}, (map) => {
    const current = map[projectId] ?? [];
    const next = withLaunchRowScript(current, scriptName, onRow);
    if (next === current) return undefined;
    if (next.length > 0) return { ...map, [projectId]: next };
    const { [projectId]: _dropped, ...rest } = map;
    return rest;
  });
}
