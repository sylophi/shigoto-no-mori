import type { CommandAccess } from "@shigomori/ui/lib/commandAccessCopy.ts";
import { useHostScope, type HostApi } from "@/hooks/remote/useHostScope";
import { useDevice, useDevices } from "@/hooks/remote/useDevices";
import { commandAccessOf, type Device, liveApi } from "@/lib/remote/devices";

// Does THIS device hold command access on the scoped host? Drives
// whether a scoped page renders mutation controls or a read-only note.
export function useCommandAccess(): CommandAccess {
  return commandAccessOf(useDevice(useHostScope().deviceId));
}

// A device's api while this device may command it (a verdict not in
// yet counts, as canCommand has it) and it can be asked, else undefined.
function commandableApiOf(device: Device | undefined): HostApi | undefined {
  return device !== undefined && commandAccessOf(device).canCommand
    ? liveApi(device)
    : undefined;
}

// The api to command a device through from here, by device id
// (commandableApiOf). The lookup the group actions and the inbox's
// create button share.
export function useCommandableApi(): (deviceId: string) => HostApi | undefined {
  const devices = useDevices();
  return (deviceId) =>
    commandableApiOf(devices.find((device) => device.deviceId === deviceId));
}

// The same for one device, the api a sidebar row reads its device's
// runs and terminals through outside any host scope: this machine's
// while it has a host, a peer's while this device may command it.
// Undefined for undefined.
export function useCommandableDeviceApi(
  deviceId: string | undefined,
): HostApi | undefined {
  const device = useDevice(deviceId);
  return device?.hostsProjects === true ? commandableApiOf(device) : undefined;
}
