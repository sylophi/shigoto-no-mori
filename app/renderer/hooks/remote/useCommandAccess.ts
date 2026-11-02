import type { CommandAccess } from "@shigomori/ui/lib/commandAccessCopy.ts";
import { useHostScope, type HostApi } from "@/hooks/remote/useHostScope";
import { usePeer, usePeers } from "@/hooks/remote/useDevices";
import { commandAccessOf, type Device, liveApi } from "@/lib/remote/devices";
import { type RendererApi, useApi } from "@/lib/runtime/pageApi";

// Does THIS device hold command access on the scoped host? Drives
// whether a scoped page renders mutation controls or a read-only note.
export function useCommandAccess(): CommandAccess {
  return useDeviceCommandAccess(useHostScope().deviceId);
}

// The same for a device by id.
export function useDeviceCommandAccess(deviceId: string): CommandAccess {
  const page = useApi();
  const peer = usePeer(deviceId);
  return commandAccessOf(
    deviceId === page.deviceId ? { isThisDevice: true } : peer,
  );
}

// A device's api while this device may command it (a verdict not in
// yet counts, as canCommand has it) and it can be asked, else undefined.
function commandableApiOf(
  page: RendererApi,
  device: Device | undefined,
): HostApi | undefined {
  return device !== undefined && commandAccessOf(device).canCommand
    ? liveApi(page, device)
    : undefined;
}

// The api to command a device through from here, by device id
// (commandableApiOf). The lookup the group actions and the inbox's
// create button share.
export function useCommandableApi(): (deviceId: string) => HostApi | undefined {
  const page = useApi();
  const devices = usePeers();
  return (deviceId) =>
    commandableApiOf(
      page,
      devices.find((device) => device.deviceId === deviceId),
    );
}

// The same for one device, the api a sidebar row reads its device's
// runs and terminals through outside any host scope: this machine's
// while it has a host, a peer's while this device may command it.
// Undefined for undefined.
export function useCommandableDeviceApi(
  deviceId: string | undefined,
): HostApi | undefined {
  const page = useApi();
  const peer = usePeer(deviceId);
  if (deviceId === page.deviceId) return page.isElectron ? page : undefined;
  return peer?.hostsProjects === true
    ? commandableApiOf(page, peer)
    : undefined;
}
