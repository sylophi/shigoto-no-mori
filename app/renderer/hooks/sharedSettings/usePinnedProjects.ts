// The projects pinned to the head of the list of projects. A shared
// setting by the project's group key (projectGroupKey), like the
// worktree sort, so a repo pinned on one device is pinned on all of
// them.
import {
  pinnedProjectKeys,
  sharedSettingKeys,
} from "@shigomori/contracts/sharedSettings";
import {
  useSetSharedSetting,
  useSharedSettingsView,
} from "./useSharedSettings";

export function usePinnedProjects(): ReadonlySet<string> {
  return new Set(useSharedSettingsView(pinnedProjectKeys));
}

export function useSetProjectPinned(groupKey: string) {
  const set = useSetSharedSetting(
    sharedSettingKeys.pinnedProject(groupKey),
    "Couldn't save the pin",
  );
  return (pinned: boolean) => set(pinned ? true : null);
}
