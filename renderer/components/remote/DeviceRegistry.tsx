// The account's device registry: one line naming the account with its
// sign-out, then one row per machine, this one first. This component
// owns every query the rows read -- the account list, the host chips
// and the per-peer command-access verdicts -- so a row is a pure
// function of what it is handed and the page makes one fan-out instead
// of one per row.
//
// The marks and the host chips' last-known marker derive from the LIVE
// hub store rather than the account:listDevices HTTP snapshot (which
// only invalidates on account:changed), so a device coming online or
// going away updates without a refetch.
import { errorMessageOf } from "@shared/errors";
import { isHubRefusal } from "@shared/account/service";
import { ClerkSignOutButton } from "@/components/account/ClerkSignOutButton";
import { ErrorBanner } from "@/components/ui/error-banner";
import {
  useAccountDevices,
  useLocalDeviceName,
  useRevokeDevice,
  useWatchCommandAccessChanges,
} from "@/hooks/account/useAccount";
import { useAccountIdentity } from "@/hooks/account/useClerkAccount";
import {
  commandAccessOf,
  usePeerCommandAccess,
} from "@/hooks/remote/useCommandAccess";
import { useRemoteDevices } from "@/hooks/remote/useRemoteDevices";
import { useHubStatus, useTunnelState } from "@/hooks/remote/useHubStatus";
import { abbreviateId } from "@/lib/abbreviateId";
import { localDeviceId } from "@/lib/queryKeys";
import { DeviceRegistryRow } from "./DeviceRegistryRow";
import { useHostChipIndex } from "./deviceHostChips";
import { deviceRowStatus } from "./deviceRegistryStatus";

export function DeviceRegistry({ accountId }: { accountId: string }) {
  useWatchCommandAccessChanges();
  const localDeviceName = useLocalDeviceName();
  const devicesQuery = useAccountDevices();
  const revokeDevice = useRevokeDevice();
  const hubDevices = useRemoteDevices();
  const hubById = new Map(
    hubDevices.map((device) => [device.deviceId, device] as const),
  );
  // THIS device's tunnel endpoint state, as the
  // derived primitive off the shared hub status store: the registry
  // re-renders when the tunnel flips, not on every roster transition.
  const tunnel = useTunnelState();
  const socket = useHubStatus()?.socket ?? null;
  const hosts = useHostChipIndex(localDeviceId);
  // Whether THIS device may drive verbs on each peer: the peer's own
  // "allow control from other devices" switch, as it answers us. Asked
  // once for the whole list (the rows' forward strips would otherwise
  // each mount their own copy under the same keys), and only for
  // peers, since the local device is granted by contract.
  const peerAccess = usePeerCommandAccess(hubDevices);

  // This device first, everything else in the order the device hub
  // listed it, so the peers keep their registry order.
  const devices = devicesQuery.data ?? [];
  const rows = [
    ...devices.filter((device) => device.deviceId === localDeviceId),
    ...devices.filter((device) => device.deviceId !== localDeviceId),
  ].map((device) => {
    const isThisDevice = device.deviceId === localDeviceId;
    const hubDevice = hubById.get(device.deviceId);
    return {
      device,
      isThisDevice,
      // setDeviceName writes this device's name locally while the hub
      // registry keeps the name it enrolled under. The local one is the
      // truth the user just typed, so the row shows it.
      name: isThisDevice ? localDeviceName : device.name,
      status: deviceRowStatus(device, isThisDevice, hubDevice, socket),
      access: commandAccessOf(peerAccess, device.deviceId),
      // This machine knows its own version synchronously. A peer
      // confirms one only once its direct session's welcome lands.
      appVersion: isThisDevice
        ? window.api.appVersion
        : (hubDevice?.appVersion ?? ""),
    };
  });
  // Two machines wearing the same name are told apart by their ids,
  // which the rows otherwise keep out of sight: an id is nothing a
  // person recognises, so it only earns its place when the name alone
  // cannot say which machine the Remove confirm is about.
  const nameCount = new Map<string, number>();
  for (const row of rows) {
    nameCount.set(row.name, (nameCount.get(row.name) ?? 0) + 1);
  }

  return (
    <section className="flex flex-col gap-5">
      {/* The account is one thin line -- who is signed in -- and the
          sign-out sits with it: ending the session is what removes THIS
          machine from the account (see the Remove button's note in the
          row). A hub account has no other properties, and the rows say
          everything about its devices, so no headcount repeats them. */}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <AccountIdentity accountId={accountId} />
        <ClerkSignOutButton className="-my-1 text-muted-foreground" />
      </div>

      {devicesQuery.isLoading ? (
        <p className="text-xs text-muted-foreground/70">
          Loading devices&hellip;
        </p>
      ) : devicesQuery.isError ? (
        // A failed list is unknown, not empty, so no "No devices yet"
        // under it.
        <ErrorBanner>{describeListError(devicesQuery.error)}</ErrorBanner>
      ) : rows.length === 0 ? (
        <p className="text-xs text-muted-foreground/70">No devices yet.</p>
      ) : (
        <ul className="divide-y divide-border">
          {rows.map(
            ({ device, isThisDevice, name, status, access, appVersion }) => (
              <DeviceRegistryRow
                key={device.deviceId}
                device={device}
                isThisDevice={isThisDevice}
                name={name}
                showId={(nameCount.get(name) ?? 0) > 1}
                status={status}
                appVersion={appVersion}
                chips={hosts.byDevice.get(device.deviceId) ?? []}
                // An unreachable peer's queries are disabled, so it is
                // never the one still fetching: without this gate one
                // slow peer would suppress every other row's empty
                // state.
                chipsLoading={
                  isThisDevice
                    ? hosts.localLoading
                    : hosts.remoteLoading && status.reachable
                }
                onRevokeDevice={() => revokeDevice.mutate(device.deviceId)}
                revokePending={
                  revokeDevice.isPending &&
                  revokeDevice.variables === device.deviceId
                }
                tunnel={isThisDevice ? tunnel : undefined}
                access={access}
              />
            ),
          )}
        </ul>
      )}
    </section>
  );
}

// One honest sentence per failure shape for a device list that would
// not load. A client cannot always tell a refusing device hub from an
// unreachable one (a browser sees no CORS headers on a failed
// response), so the fetch-failure branch names both possibilities
// instead of guessing.
function describeListError(error: unknown): string {
  if (isHubRefusal(error)) {
    return "The device hub refused this request, so the device list is unavailable.";
  }
  if (error instanceof TypeError) {
    return (
      "Couldn't reach the device hub. Either you are offline, or this " +
      "build's hub URL does not point at a reachable Worker."
    );
  }
  return `Couldn't load the device list: ${errorMessageOf(error)}`;
}

// The person, not the account's key: the hub keys on the Clerk user
// id, but nobody recognises that string as themselves, so the line
// reads the email (or name) Clerk knows and only falls back to the
// abbreviated id while the profile is still loading. A leaf, like the
// sign-out button beside it, so Clerk's session churn re-renders one
// span and not the registry.
function AccountIdentity({ accountId }: { accountId: string }) {
  const identity = useAccountIdentity(abbreviateId(accountId));
  return (
    <p className="text-xs text-muted-foreground">
      Signed in as{" "}
      <span className="font-medium text-foreground select-text">
        {identity}
      </span>
    </p>
  );
}
