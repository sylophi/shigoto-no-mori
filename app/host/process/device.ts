// The account calls a shell makes of this device (the session contract's,
// and the headless shell's in this process), on the Colibrii device
// (PeerDevice.ts). A listing is also how the host learns a peer left
// the account (noteAccountDevices).
import type { AccountState, Device } from "@colibrii/sdk";
import type { DeviceInfo } from "@shigomori/contracts/hubProtocol";
import type { DeviceData } from "@shigomori/contracts/modules/session";
import { listDevicesOf } from "@shared/account/deviceInfo";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as PeerDevice from "@host/lib/PeerDevice";
import * as Graph from "./graph";
import { noteAccountDevices } from "./handlers";

const onDevice = <A, E>(call: (device: Device) => Effect.Effect<A, E>) =>
  Graph.run(Effect.flatMap(PeerDevice.PeerDevice, call));

export const deviceCalls = {
  account: (): Promise<AccountState> =>
    onDevice((device) =>
      Stream.runHead(device.account).pipe(Effect.map(Option.getOrThrow)),
    ),
  enroll: (input: {
    readonly loginToken: string;
    readonly name: string;
    readonly data: DeviceData;
  }): Promise<void> => onDevice((device) => device.enroll(input)),
  signOut: (): Promise<boolean> => onDevice((device) => device.signOut),
  listDevices: async (): Promise<DeviceInfo[]> => {
    const devices = await onDevice(listDevicesOf);
    noteAccountDevices(devices.map((device) => device.deviceId));
    return devices;
  },
  renameDevice: ({
    deviceId,
    name,
  }: {
    readonly deviceId: string;
    readonly name: string;
  }): Promise<void> =>
    onDevice((device) => device.devices.rename(deviceId, name)),
  setDeviceData: ({
    deviceId,
    data,
  }: {
    readonly deviceId: string;
    readonly data: DeviceData;
  }): Promise<void> =>
    onDevice((device) => device.devices.setData(deviceId, data)),
  removeDevice: (deviceId: string): Promise<void> =>
    onDevice((device) => device.devices.remove(deviceId)),
};
