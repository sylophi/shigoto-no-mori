// The account's device registry: a summary line and one card per
// machine, this one first. This component owns every query the rows
// read -- the account list, the grants, the host chips and the per-peer
// command-access verdicts -- so a row is a pure function of what it is
// handed and the page makes one fan-out instead of one per row.
//
// The dot, the summary count and the host chips' cached marker all
// derive from the LIVE relay store rather than the account:listDevices
// HTTP snapshot (which only invalidates on account:changed), so a
// device coming online or going away updates without a refetch.
import {
  useAccountDevices,
  useGrantCommands,
  useGrantedDevices,
  useRevokeCommands,
  useRevokeDevice,
  useWatchGrantsChanges,
} from "@/hooks/account/useAccount";
import { usePeerCommandAccess } from "@/hooks/remote/useCommandAccess";
import { useRemoteDevices } from "@/hooks/remote/useRemoteDevices";
import { useTunnelState } from "@/hooks/remote/useRelayStatus";
import { localDeviceId } from "@/lib/queryKeys";
import { DeviceRegistryRow } from "./DeviceRegistryRow";
import { useHostChipIndex } from "./deviceHostChips";
import { deviceRowStatus } from "./deviceRegistryStatus";

export function DeviceRegistry({
  localDeviceName,
}: {
  // This device's locally stored name, from account status.
  localDeviceName: string;
}) {
  useWatchGrantsChanges();
  const devicesQuery = useAccountDevices();
  // The peers this host grants command access. Host-local, so it is
  // independent of whether the peer is online -- and so the toggle
  // keeps working on an offline row, which is the point: you decide
  // what a machine may do here before it next knocks.
  const grantedSet = new Set(useGrantedDevices().data ?? []);
  const grantCommands = useGrantCommands();
  const revokeCommands = useRevokeCommands();
  const revokeDevice = useRevokeDevice();
  const relayDevices = useRemoteDevices();
  const relayById = new Map(
    relayDevices.map((device) => [device.deviceId, device] as const),
  );
  // THIS device's tunnel endpoint state (v2 step 10, slice B), as the
  // derived primitive off the shared relay status store: the registry
  // re-renders when the tunnel flips, not on every roster transition.
  const tunnel = useTunnelState();
  const hosts = useHostChipIndex(localDeviceId);
  // Whether THIS device may drive verbs on each peer -- the mirror of
  // `grantedSet` above, which is what this host allows peers to do here.
  // Asked once for the whole list (the rows' forward blocks would
  // otherwise each mount their own copy under the same keys), and only
  // for peers, since the local device is granted by contract.
  const peerAccess = usePeerCommandAccess(relayDevices);

  // This device first, everything else in the order the relay listed
  // it, so the peers keep their registry order.
  const devices = devicesQuery.data ?? [];
  const rows = [
    ...devices.filter((device) => device.deviceId === localDeviceId),
    ...devices.filter((device) => device.deviceId !== localDeviceId),
  ].map((device) => {
    const isThisDevice = device.deviceId === localDeviceId;
    const relayDevice = relayById.get(device.deviceId);
    return {
      device,
      isThisDevice,
      status: deviceRowStatus(device, isThisDevice, relayDevice),
      canCommandPeer: peerAccess.get(device.deviceId)?.granted ?? false,
      // This machine knows its own version synchronously. A peer
      // confirms one only once its direct session's welcome lands.
      appVersion: isThisDevice
        ? window.api.appVersion
        : (relayDevice?.appVersion ?? ""),
    };
  });
  const online = rows.filter((row) => row.status.reachable).length;

  if (devicesQuery.isLoading) {
    return (
      <p className="text-xs text-muted-foreground/70">
        Loading devices&hellip;
      </p>
    );
  }
  if (rows.length === 0) {
    return <p className="text-xs text-muted-foreground/70">No devices yet.</p>;
  }

  return (
    <section className="flex flex-col gap-2">
      <p className="text-xs text-muted-foreground">
        {rows.length} {rows.length === 1 ? "device" : "devices"} &middot;{" "}
        {online} online
      </p>
      {rows.map(
        ({ device, isThisDevice, status, appVersion, canCommandPeer }) => (
          <DeviceRegistryRow
            key={device.deviceId}
            device={device}
            isThisDevice={isThisDevice}
            localDeviceName={localDeviceName}
            status={status}
            appVersion={appVersion}
            chips={hosts.byDevice.get(device.deviceId) ?? []}
            // An unreachable peer's queries are disabled, so it is never
            // the one still fetching: without this gate one slow peer
            // would suppress every other row's empty state.
            chipsLoading={
              isThisDevice
                ? hosts.localLoading
                : hosts.remoteLoading && status.reachable
            }
            granted={grantedSet.has(device.deviceId)}
            grantPending={
              (grantCommands.isPending &&
                grantCommands.variables === device.deviceId) ||
              (revokeCommands.isPending &&
                revokeCommands.variables === device.deviceId)
            }
            onGrant={() => grantCommands.mutate(device.deviceId)}
            onRevokeCommands={() => revokeCommands.mutate(device.deviceId)}
            onRevokeDevice={() => revokeDevice.mutate(device.deviceId)}
            revokePending={
              revokeDevice.isPending &&
              revokeDevice.variables === device.deviceId
            }
            tunnel={isThisDevice ? tunnel : undefined}
            canCommandPeer={canCommandPeer}
          />
        ),
      )}
    </section>
  );
}
