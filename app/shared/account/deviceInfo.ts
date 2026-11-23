// A device of the account as Colibrii lists it, as sm shows it: its
// platform and icon are what sm keeps in its data (DeviceDataSchema). An
// icon this build's catalog lacks reads as its platform's.
import type { Device, DeviceRecord } from "@colibrii/sdk";
import {
  errorMessageOf,
  HubCredentialRejectedError,
  HubDeviceRevokedError,
  HubRateLimitedError,
  HubUnreachableError,
  HubUpdateRequiredError,
} from "@shigomori/contracts/errors";
import {
  fallbackDeviceIcon,
  isDeviceIcon,
} from "@shigomori/contracts/deviceIcon";
import type { DeviceInfo } from "@shigomori/contracts/hubProtocol";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import type { DevicePort } from "./handlers";

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

// The account's devices. The service's refusals and its rate limit
// cross as the contract's, which a window and the terminal word apart.
const listDevicesOf = (device: Device) =>
  device.devices.list.pipe(
    Effect.map((records) => records.map(deviceInfoOf)),
    Effect.catchTags({
      RateLimited: ({ retryAfterSeconds }) =>
        Effect.fail(new HubRateLimitedError({ retryAfterSeconds })),
      DeviceRevoked: () => Effect.fail(new HubDeviceRevokedError()),
      CredentialRejected: () => Effect.fail(new HubCredentialRejectedError()),
      UpdateRequired: (error) =>
        Effect.fail(
          new HubUpdateRequiredError({
            floor: error.floor,
            error: error.message,
          }),
        ),
      HubUnreachable: ({ cause }) =>
        Effect.fail(new HubUnreachableError({ detail: errorMessageOf(cause) })),
    }),
  );

// The account calls on a Colibrii device, run on it as `onDevice` has it.
export const devicePortOf = (
  onDevice: <A, E>(call: (device: Device) => Effect.Effect<A, E>) => Promise<A>,
): DevicePort => ({
  account: () =>
    onDevice((device) =>
      Stream.runHead(device.account).pipe(Effect.map(Option.getOrThrow)),
    ),
  enroll: (input) => onDevice((device) => device.enroll(input)),
  signOut: () => onDevice((device) => device.signOut),
  listDevices: () => onDevice(listDevicesOf),
  renameDevice: ({ deviceId, name }) =>
    onDevice((device) => device.devices.rename(deviceId, name)),
  setDeviceData: ({ deviceId, data }) =>
    onDevice((device) => device.devices.setData(deviceId, data)),
  removeDevice: (deviceId) =>
    onDevice((device) => device.devices.remove(deviceId)),
});
