// Which device a project header's `+` creates on when the project spans
// several machines. A shared setting by repo identity (the merged
// header IS the identity group), so the pick made on one device holds
// on all of them. Undefined means no pick: the header falls back to
// its first live device, this machine first.
import { sharedSettingKeys } from "@shared/sharedSettings";
import {
  useSetSharedSetting,
  useSharedStringSetting,
} from "./useSharedSettings";

// The read alone, for every header: one observer on the shared
// settings doc, no mutation.
export function useQuickCreateDeviceId(
  identity: string | null | undefined,
): string | undefined {
  return useSharedStringSetting(
    identity == null
      ? undefined
      : sharedSettingKeys.quickCreateDevice(identity),
  );
}

// The writer, for the surface that offers the pick (the Configure
// page). A no-op for an identity-less project: there is only ever one
// checkout of it to create in.
export function useSetQuickCreateDevice(identity: string | null | undefined) {
  return useSetSharedSetting(
    identity == null
      ? undefined
      : sharedSettingKeys.quickCreateDevice(identity),
    "Couldn't save the create device",
  );
}
