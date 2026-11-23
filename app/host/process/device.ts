// The account calls a shell makes of this device (the session contract's,
// and the headless shell's in this process), on the Colibrii device
// (PeerDevice.ts). A listing is also how the host learns a peer left
// the account (noteAccountDevices).
import { devicePortOf } from "@shared/account/deviceInfo";
import type { DevicePort } from "@shared/account/handlers";
import * as Effect from "effect/Effect";
import * as PeerDevice from "@host/lib/PeerDevice";
import * as Graph from "./graph";
import { noteAccountDevices, noteDeviceRemoved } from "./handlers";

const calls = devicePortOf((call) =>
  Graph.run(Effect.flatMap(PeerDevice.PeerDevice, call)),
);

export const deviceCalls: DevicePort = {
  ...calls,
  listDevices: async () => {
    const devices = await calls.listDevices();
    noteAccountDevices(devices.map((device) => device.deviceId));
    return devices;
  },
  removeDevice: async (deviceId) => {
    await calls.removeDevice(deviceId);
    noteDeviceRemoved(deviceId);
  },
};
