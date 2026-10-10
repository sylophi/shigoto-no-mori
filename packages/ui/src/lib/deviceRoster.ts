// The machines on the account as a device pick draws them. The app's
// roster (components/shared/DeviceTabs.tsx) builds these with the API
// scoped to each device on top, which no view reads.
import type { DeviceIcon } from "@shigomori/contracts/deviceIcon";
import type { Project } from "@shigomori/contracts/schemas";
import type { DeviceStatusView } from "./deviceStatus.ts";

export interface DeviceRosterEntry {
  deviceId: string;
  label: string;
  // What it looks like (DeviceGlyphView), so every pick draws it.
  icon: DeviceIcon;
  isThisDevice: boolean;
  // Null for this device, which has no connection to describe.
  status: DeviceStatusView | null;
}

// Why a device can't host a create. Ordered by how the user would ask:
// a machine that isn't there can't be missing a checkout yet.
export type DeviceBlock = "offline" | "no-project" | "no-grant";

// A device holding this repo, or offered as the place to create.
export type DeviceTarget = DeviceRosterEntry & {
  // The identity-matched project ON THAT DEVICE -- the id every scoped
  // hook keys off once a page moves there. Undefined when the device
  // has no checkout of this repo.
  project: Project | undefined;
  // Undefined when the device can host the create.
  block: DeviceBlock | undefined;
};
