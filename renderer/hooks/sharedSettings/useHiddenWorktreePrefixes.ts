// The worktrees the sidebar hides the way it hides shelved ones: those
// whose name or branch starts with one of these prefixes, in every
// project. A shared setting, so the list is the same on every device.
import { notifyError } from "@/lib/toast";
import {
  hiddenPrefixesValue,
  parseHiddenPrefixes,
  sharedSettingKeys,
} from "@shared/sharedSettings";
import {
  useSetSharedSetting,
  useSharedStringSetting,
} from "./useSharedSettings";

const KEY = sharedSettingKeys.hiddenWorktreePrefixes;

export function useHiddenWorktreePrefixes(): string[] {
  return parseHiddenPrefixes(useSharedStringSetting(KEY));
}

// The writer. The whole list is one value, which holds only so much:
// a list past that is refused out loud rather than cut short. The
// answer is the list as stored, or null when it was refused.
export function useSaveHiddenWorktreePrefixes() {
  const set = useSetSharedSetting(KEY, "Couldn't save the hidden prefixes");
  return (prefixes: readonly string[]): string[] | null => {
    const value = hiddenPrefixesValue(prefixes);
    if (value === null) {
      notifyError(
        "The prefix list is too long",
        "Shorten or remove a prefix to add another.",
      );
      return null;
    }
    // An empty list clears the setting.
    set(value === "" ? null : value);
    return parseHiddenPrefixes(value);
  };
}
