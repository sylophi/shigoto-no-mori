// How the tree orders a project's worktrees. A shared setting by the
// project's group key (projectGroupKey), so the pick made on one device
// holds on all of them, like the merged group it orders. Unset, or
// written by a build with a mode this one doesn't know, reads as the
// name order.
import { type WorktreeSortMode, WorktreeSortModeSchema } from "@shared/schemas";
import { sharedSettingKeys } from "@shared/sharedSettings";
import {
  useSetSharedSetting,
  useSharedStringSetting,
} from "./useSharedSettings";

// Null: no project open, which reads as the name order.
export function useWorktreeSort(groupKey: string | null): WorktreeSortMode {
  const parsed = WorktreeSortModeSchema.safeParse(
    useSharedStringSetting(
      groupKey === null ? undefined : sharedSettingKeys.worktreeSort(groupKey),
    ),
  );
  return parsed.success ? parsed.data : "name";
}

export function useSetWorktreeSort(groupKey: string) {
  return useSetSharedSetting(
    sharedSettingKeys.worktreeSort(groupKey),
    "Couldn't save the worktree sort",
  );
}
