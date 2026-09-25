// What a mirror or transplant of a project leaves out before the
// dialog is touched. A shared setting by repo identity, like the create
// device: the two ends of a pull are different devices, so a preset
// kept in either one's project file would hold for half the pulls. An
// identity-less project never pairs with another device's, so it reads
// the default and its writer is a no-op.
import { notifyError } from "@/lib/toast";
import {
  type LeaveOutPreset,
  leaveOutPresetValue,
  parseLeaveOutPreset,
  sharedSettingKeys,
} from "@shared/sharedSettings";
import {
  useSetSharedSetting,
  useSharedStringSetting,
} from "./useSharedSettings";

function keyFor(identity: string | null | undefined): string | undefined {
  return identity == null
    ? undefined
    : sharedSettingKeys.leaveOutPreset(identity);
}

export function useLeaveOutPreset(
  identity: string | null | undefined,
): LeaveOutPreset {
  return parseLeaveOutPreset(useSharedStringSetting(keyFor(identity)));
}

// The writer. The whole rule is one value, which holds only so many
// paths: a rule past that is refused out loud rather than cut short,
// and the answer says whether the rule was taken.
export function useSaveLeaveOutPreset(identity: string | null | undefined) {
  const set = useSetSharedSetting(
    keyFor(identity),
    "Couldn't save the leave-out default",
  );
  return (next: LeaveOutPreset): boolean => {
    const value = leaveOutPresetValue(next);
    if (value === null) {
      notifyError(
        "Too many paths for a project default",
        "Pick a parent folder instead, or remove a few.",
      );
      return false;
    }
    set(value);
    return true;
  };
}
