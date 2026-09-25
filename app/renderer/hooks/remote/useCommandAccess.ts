import { useSyncExternalStore } from "react";
import { localDeviceId } from "@/lib/queryKeys";
import { useHostScope, type HostApi } from "@/hooks/remote/useHostScope";
import { useRemoteDevices } from "@/hooks/remote/useRemoteDevices";
import { type RemoteDevice, remoteDeviceStore } from "@/lib/remote/devices";

// Whether THIS device may command a device: the other machine's own
// "allow control from other devices" switch, as its connectInfo answer
// and its live push report it (HubStatus.peerAcceptsCommands, carried
// on the registry entry). A reading for the UI only: the peer's direct
// listener enforces the switch on every call regardless.
export interface CommandAccess {
  granted: boolean;
  // No direct session yet, so the peer has not said.
  isLoading: boolean;
  // Whether a surface should offer commands right now: granted, or the
  // verdict not in yet (assume granted rather than flash a disabled
  // control that turns live a moment later).
  canCommand: boolean;
}

const GRANTED: CommandAccess = {
  granted: true,
  isLoading: false,
  canCommand: true,
};
const PENDING: CommandAccess = {
  granted: false,
  isLoading: true,
  canCommand: true,
};
const REFUSED: CommandAccess = {
  granted: false,
  isLoading: false,
  canCommand: false,
};

// The verdict for one device, given its registry entry (undefined for
// this device, which the registry does not list, and for a peer it no
// longer knows). This device always commands itself.
export function commandAccessOf(
  deviceId: string,
  device: Pick<RemoteDevice, "acceptsCommands"> | undefined,
): CommandAccess {
  if (deviceId === localDeviceId) return GRANTED;
  const accepts = device?.acceptsCommands;
  if (accepts === undefined) return PENDING;
  return accepts ? GRANTED : REFUSED;
}

// Does THIS device hold command access on the scoped host? Drives
// whether a scoped page renders mutation controls or a read-only note.
// A selector over the registry, so another peer's churn leaves the
// value, and the render, alone.
export function useCommandAccess(): CommandAccess {
  const { deviceId } = useHostScope();
  const select = () =>
    remoteDeviceStore.getSnapshot().find((entry) => entry.deviceId === deviceId)
      ?.acceptsCommands;
  const accepts = useSyncExternalStore(
    remoteDeviceStore.subscribe,
    select,
    select,
  );
  return commandAccessOf(deviceId, { acceptsCommands: accepts });
}

// The api to command a peer through from here, by device id: its
// session's, while that peer lets this device command it (a verdict
// not in yet counts, as canCommand has it), else undefined. The lookup
// the group actions and the inbox's create button share.
export function useCommandableApi(): (deviceId: string) => HostApi | undefined {
  const registry = useRemoteDevices();
  return (deviceId) => {
    const device = registry.find((entry) => entry.deviceId === deviceId);
    return commandAccessOf(deviceId, device).canCommand
      ? device?.api
      : undefined;
  };
}
