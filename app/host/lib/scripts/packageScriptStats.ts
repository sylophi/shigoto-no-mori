// Per-repo sort preference, manual order and launch-row picks for the
// package.json scripts list, in the store (the engine's Scripts). The
// use log the "Most used" sort ranks by counts every run and comes back
// with the list.
import type { PackageScriptSortMode } from "@shigomori/contracts/schemas";
import * as Effect from "effect/Effect";
import * as Ops from "../engineOps";

export const readScriptSort = (projectId: string) =>
  Ops.onScripts((scripts) =>
    Effect.map(
      scripts.arrangement(projectId),
      ({ sort }) => sort as PackageScriptSortMode,
    ),
  );

// "frequent" is the implicit default: switching back to it deletes
// the stored entry instead of writing it.
export const writeScriptSort = (
  projectId: string,
  mode: PackageScriptSortMode,
) => Ops.onScripts((scripts) => scripts.setSort(projectId, mode), true);

export const readScriptOrder = (projectId: string) =>
  Ops.onScripts((scripts) =>
    Effect.map(scripts.arrangement(projectId), ({ order }) => [...order]),
  );

// `arranged` is one worktree's scripts in their new order, merged
// against the stored order rather than by the client against its cached
// copy, which another window may have written past.
export const writeScriptOrder = (
  projectId: string,
  arranged: readonly string[],
) => Ops.onScripts((scripts) => scripts.arrange(projectId, arranged), true);

// The scripts put on the launch row by hand, which the row limits itself
// to under the "manual" sort. Project-wide like the order, so it can
// name scripts a given worktree lacks. Empty means none were picked.
export const readLaunchRow = (projectId: string) =>
  Ops.onScripts((scripts) => scripts.launchRow(projectId));

// One script on or off the row, applied against the stored row rather
// than as a whole list from the client, so two windows picking
// different scripts both land.
export const writeLaunchRowScript = (
  projectId: string,
  scriptName: string,
  onRow: boolean,
) =>
  Ops.onScripts(
    (scripts) => scripts.setOnLaunchRow(projectId, scriptName, onRow),
    true,
  );
