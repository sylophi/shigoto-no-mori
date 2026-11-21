// A device of the account as Colibrii lists it, as sm shows it: its
// platform and icon are what sm keeps in its data (DeviceDataSchema). An
// icon this build's catalog lacks reads as its platform's.
import type { Device, DeviceRecord } from "@colibrii/sdk";
import { HubRateLimitedError } from "@shigomori/contracts/errors";
import {
  fallbackDeviceIcon,
  isDeviceIcon,
} from "@shigomori/contracts/deviceIcon";
import type { DeviceInfo } from "@shigomori/contracts/hubProtocol";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";

const deviceInfoOf = (record: DeviceRecord): DeviceInfo => {
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

// The account's devices. The service's rate limit crosses as the
// contract's, which keeps how long to wait.
export const listDevicesOf = (device: Device) =>
  device.devices.list.pipe(
    Effect.map((records) => records.map(deviceInfoOf)),
    Effect.mapError((error) =>
      Predicate.isTagged(error, "RateLimited")
        ? new HubRateLimitedError({
            retryAfterSeconds: error.retryAfterSeconds,
          })
        : error,
    ),
  );
