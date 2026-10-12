import { useAtomValue } from "@effect/atom-react";
import type { CommandAccess } from "@shigomori/ui/lib/commandAccessCopy.ts";
import { useHostScope, type HostApi } from "@/hooks/remote/useHostScope";
import { useRemoteDevices } from "@/hooks/remote/useRemoteDevices";
import {
  type RemoteDevice,
  type RemoteDeviceApi,
  remoteDevicesAtom,
} from "@/lib/remote/devices";
import { useApi } from "@/lib/runtime/pageApi";

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
// longer knows). This device (`localDeviceId`) always commands itself.
export function commandAccessOf(
  localDeviceId: string,
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
  const localDeviceId = useApi().deviceId;
  const { deviceId } = useHostScope();
  const accepts = useAtomValue(
    remoteDevicesAtom,
    (devices) =>
      devices.find((entry) => entry.deviceId === deviceId)?.acceptsCommands,
  );
  return commandAccessOf(localDeviceId, deviceId, {
    acceptsCommands: accepts,
  });
}

// A device's api while this device may command it (a verdict not in
// yet counts, as canCommand has it), else undefined.
function commandableApiOf(
  localDeviceId: string,
  deviceId: string,
  device: RemoteDevice | undefined,
): RemoteDeviceApi | undefined {
  return commandAccessOf(localDeviceId, deviceId, device).canCommand
    ? device?.api
    : undefined;
}

// The api to command a peer through from here, by device id
// (commandableApiOf). The lookup the group actions and the inbox's
// create button share.
export function useCommandableApi(): (deviceId: string) => HostApi | undefined {
  const localDeviceId = useApi().deviceId;
  const registry = useRemoteDevices();
  return (deviceId) =>
    commandableApiOf(
      localDeviceId,
      deviceId,
      registry.find((entry) => entry.deviceId === deviceId),
    );
}

// The same for one peer, as a selector (useRemoteDeviceApi's), so a row
// drawn per worktree doesn't re-render on every other peer's churn.
// Undefined for undefined.
export function useCommandableDeviceApi(
  deviceId: string | undefined,
): RemoteDeviceApi | undefined {
  const localDeviceId = useApi().deviceId;
  return useAtomValue(remoteDevicesAtom, (devices) =>
    deviceId === undefined
      ? undefined
      : commandableApiOf(
          localDeviceId,
          deviceId,
          devices.find((entry) => entry.deviceId === deviceId),
        ),
  );
}
