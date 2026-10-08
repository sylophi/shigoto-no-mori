// How the tree orders a project's worktrees. A shared setting by the
// project's group key (projectGroupKey), so the pick made on one device
// holds on all of them, like the merged group it orders. Unset, or
// written by a build with a mode this one doesn't know, reads as the
// name order.
import {
  type SharedSettingsDoc,
  type WorktreeSortMode,
  WorktreeSortModeSchema,
} from "@shared/schemas";
import { sharedSettingKeys, worktreeSortValues } from "@shared/sharedSettings";
import {
  useSetSharedSetting,
  useSharedSettingsView,
} from "./useSharedSettings";

// The sorts out of the document, by group key, the unknown ones left
// out. Only the sorts, so a move of any other setting re-renders nobody.
function sortModes(doc: SharedSettingsDoc): Record<string, WorktreeSortMode> {
  const modes: Record<string, WorktreeSortMode> = {};
  for (const [groupKey, value] of worktreeSortValues(doc)) {
    const parsed = WorktreeSortModeSchema.safeParse(value);
    if (parsed.success) modes[groupKey] = parsed.data;
  }
  return modes;
}

// Every project's sort, by group key: the open project's, or on the
// inline list every project's.
export function useWorktreeSorts(): (groupKey: string) => WorktreeSortMode {
  const sorts = useSharedSettingsView(sortModes);
  return (groupKey) => sorts?.[groupKey] ?? "name";
}

export function useSetWorktreeSort(groupKey: string) {
  return useSetSharedSetting(
    sharedSettingKeys.worktreeSort(groupKey),
    "Couldn't save the worktree sort",
  );
}
