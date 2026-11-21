// A device of the account as Colibrii lists it, as sm shows it: its
// platform and icon are what sm keeps in its data (DeviceDataSchema). An
// icon this build's catalog lacks reads as its platform's.
import type { DeviceRecord } from "@colibrii/sdk";
import {
  fallbackDeviceIcon,
  isDeviceIcon,
} from "@shigomori/contracts/deviceIcon";
import type { DeviceInfo } from "@shigomori/contracts/hubProtocol";

export const deviceInfoOf = (record: DeviceRecord): DeviceInfo => {
  const { platform, icon } = record.data;
  const known = typeof platform === "string" ? platform : "";
  return {
    deviceId: record.deviceId,
    name: record.name,
    platform: known,
    icon: isDeviceIcon(icon) ? icon : fallbackDeviceIcon(known),
    createdAt: record.createdAt,
    lastSeenAt: record.lastSeenAt,
    online: record.online,
  };
};
