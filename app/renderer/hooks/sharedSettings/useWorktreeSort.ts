// How the tree orders a project's worktrees. A shared setting by the
// project's group key (projectGroupKey), so the pick made on one device
// holds on all of them, like the merged group it orders. Unset, or
// written by a build with a mode this one doesn't know, reads as the
// name order.
import * as Schema from "effect/Schema";
import { type WorktreeSortMode, WorktreeSortModeSchema } from "@shared/schemas";
import { sharedSettingKeys } from "@shared/sharedSettings";
import {
  useSetSharedSetting,
  useSharedStringSetting,
} from "./useSharedSettings";

// Null: no project open, which reads as the name order.
export function useWorktreeSort(groupKey: string | null): WorktreeSortMode {
  const stored = useSharedStringSetting(
    groupKey === null ? undefined : sharedSettingKeys.worktreeSort(groupKey),
  );
  return Schema.is(WorktreeSortModeSchema)(stored) ? stored : "name";
}

export function useSetWorktreeSort(groupKey: string) {
  return useSetSharedSetting(
    sharedSettingKeys.worktreeSort(groupKey),
    "Couldn't save the worktree sort",
  );
}
