// The worktree prefix lists, matched against a worktree's name or
// branch in every project: the hidden ones, which the sidebar folds
// away the way it does shelved ones, and the grouped ones, which a
// project's tree and the inbox gather under a header each. Shared settings, so the
// lists are the same on every device.
import { notifyError } from "@/lib/toast";
import {
  parseWorktreePrefixes,
  sharedSettingKeys,
  worktreePrefixesValue,
} from "@shared/sharedSettings";
import {
  useSetSharedSetting,
  useSharedStringSetting,
} from "./useSharedSettings";

export type WorktreePrefixList = "hidden" | "grouped";

const KEYS: Record<WorktreePrefixList, string> = {
  hidden: sharedSettingKeys.hiddenWorktreePrefixes,
  grouped: sharedSettingKeys.groupedWorktreePrefixes,
};

export function useWorktreePrefixes(list: WorktreePrefixList): string[] {
  return parseWorktreePrefixes(useSharedStringSetting(KEYS[list]));
}

// The writer. The whole list is one value, which holds only so much:
// a list past that is refused out loud rather than cut short. The
// answer is the list as stored, or null when it was refused.
export function useSaveWorktreePrefixes(list: WorktreePrefixList) {
  const set = useSetSharedSetting(
    KEYS[list],
    `Couldn't save the ${list} prefixes`,
  );
  return (prefixes: readonly string[]): string[] | null => {
    const value = worktreePrefixesValue(prefixes);
    if (value === null) {
      notifyError(
        "The prefix list is too long",
        "Shorten or remove a prefix to add another.",
      );
      return null;
    }
    // An empty list clears the setting.
    set(value === "" ? null : value);
    return parseWorktreePrefixes(value);
  };
}
