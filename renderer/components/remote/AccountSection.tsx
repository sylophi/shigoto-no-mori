import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { ArrowRight, LogIn, LogOut } from "lucide-react";
import type { DeviceInfo } from "@shared/relay/protocol";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SectionHeading } from "@/components/ui/section-heading";
import { StatusDot } from "@/components/ui/status-dot";
import { DeviceStatusDot } from "@/components/remote/DeviceStatusDot";
import {
  useAccountDevices,
  useAccountStatus,
  useGrantCommands,
  useGrantedDevices,
  useRevokeCommands,
  useSetDeviceName,
  useSignIn,
  useSignOut,
  useWatchGrantsChanges,
} from "@/hooks/account/useAccount";
import { useRemoteDevices } from "@/hooks/remote/useRemoteDevices";
import type { RemoteDevice } from "@/lib/remote/devices";
import { deviceStatusView } from "@/lib/remote/deviceStatus";

// "Account": sign in to the relay so this device can reach the account's
// other devices (v2 step 4, slice B). Two states: signed out (a Sign in
// button) and signed in (this device's identity plus the account's
// device registry). An online device's row links to its remote forest
// over the relay (slice C).
export function AccountSection() {
  useWatchGrantsChanges();
  const { data: status } = useAccountStatus();
  const signIn = useSignIn();
  const signOut = useSignOut();

  const signedIn = status?.signedIn === true;
  const devicesQuery = useAccountDevices(signedIn);
  // The peers this host grants command access, so each peer row can offer
  // an "Allow commands" / "Revoke" toggle. Host-local, so it is
  // independent of whether the peer is online.
  const grantedSet = new Set(useGrantedDevices(signedIn).data ?? []);
  const grantCommands = useGrantCommands();
  const revokeCommands = useRevokeCommands();
  // The dot and "View forest" gate derive from the live relay store, not
  // the account:listDevices HTTP snapshot (which only invalidates on
  // account:changed), so a device coming online or offline updates
  // without a refetch (I3).
  const relayById = new Map(
    useRemoteDevices().map((device) => [device.deviceId, device] as const),
  );

  // Unreachable in practice: the sidebar's Devices button renders only
  // when the account service is configured, so an unconfigured build
  // never navigates here. Render nothing rather than keep explanatory
  // copy alive for a state the nav already prevents.
  if (status !== undefined && !status.configured) return null;

  return (
    <section className="space-y-3">
      <div>
        <SectionHeading className="mb-1">Account</SectionHeading>
        <p className="text-xs text-muted-foreground">
          Sign in to reach this account&apos;s other devices through the relay.
          Enrollment stores a device credential in your OS keychain.
        </p>
      </div>

      {status === undefined ? (
        <p className="text-xs text-muted-foreground/70">Loading&hellip;</p>
      ) : !signedIn ? (
        <Button
          variant="outline"
          size="sm"
          disabled={signIn.isPending}
          onClick={() => signIn.mutate()}
        >
          <LogIn />
          {signIn.isPending ? "Signing in…" : "Sign in"}
        </Button>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-col gap-0.5">
            <span className="text-xs text-muted-foreground">
              Account{" "}
              <span className="font-mono text-foreground">
                {abbreviateId(status.accountId)}
              </span>
            </span>
          </div>

          <DeviceNameField deviceName={status.deviceName} />

          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">Devices</p>
            {devicesQuery.isLoading ? (
              <p className="text-xs text-muted-foreground/70">
                Loading devices&hellip;
              </p>
            ) : (devicesQuery.data ?? []).length === 0 ? (
              <p className="text-xs text-muted-foreground/70">
                No devices yet.
              </p>
            ) : (
              <div className="space-y-2">
                {(devicesQuery.data ?? []).map((device) => (
                  <DeviceRow
                    key={device.deviceId}
                    device={device}
                    isThisDevice={device.deviceId === window.api.deviceId}
                    relayDevice={relayById.get(device.deviceId)}
                    granted={grantedSet.has(device.deviceId)}
                    grantPending={
                      (grantCommands.isPending &&
                        grantCommands.variables === device.deviceId) ||
                      (revokeCommands.isPending &&
                        revokeCommands.variables === device.deviceId)
                    }
                    onGrant={() => grantCommands.mutate(device.deviceId)}
                    onRevoke={() => revokeCommands.mutate(device.deviceId)}
                  />
                ))}
              </div>
            )}
          </div>

          <Button
            variant="ghost"
            size="sm"
            disabled={signOut.isPending}
            onClick={() => signOut.mutate()}
          >
            <LogOut />
            Sign out
          </Button>
        </div>
      )}
    </section>
  );
}

// One device row: an online dot, the name, this-device marker, and the
// platform plus device id as a muted sub-line. An online peer gets the
// "View forest" affordance, navigating to the device route the registry
// serves over the relay bridge. A peer that is not this device also
// gets a command-grant toggle: until this host grants it, the peer sees
// a read-only mirror and its mutating calls are refused at the relay
// link (transport-enforced, slice D).
function DeviceRow({
  device,
  isThisDevice,
  relayDevice,
  granted,
  grantPending,
  onGrant,
  onRevoke,
}: {
  device: DeviceInfo;
  isThisDevice: boolean;
  relayDevice: RemoteDevice | undefined;
  granted: boolean;
  grantPending: boolean;
  onGrant: () => void;
  onRevoke: () => void;
}) {
  const navigate = useNavigate();
  // A peer is reachable when its relay entry is in the connected phase
  // (socket up and the peer in the presence roster), which is also when
  // its api is serving, so the forest lookup will find it.
  const reachable =
    relayDevice !== undefined && deviceStatusView(relayDevice.status).connected;
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-md border border-border px-3 py-2">
      {isThisDevice ? (
        <StatusDot tone="emerald" />
      ) : relayDevice !== undefined ? (
        <DeviceStatusDot status={relayDevice.status} />
      ) : (
        <StatusDot tone="slate" />
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm">
          {device.name}
          {isThisDevice && (
            <span className="ml-2 text-xs text-muted-foreground">
              (this device)
            </span>
          )}
          {relayDevice?.direct === true && (
            <span className="ml-2 text-xs text-muted-foreground">direct</span>
          )}
        </span>
        <span className="truncate font-mono text-[10px] text-muted-foreground">
          {device.platform} &middot; {device.deviceId}
        </span>
      </div>
      {!isThisDevice && (
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-muted-foreground">
            {granted ? "Can run commands here" : "Read-only"}
          </span>
          <Button
            variant={granted ? "ghost" : "outline"}
            size="sm"
            disabled={grantPending}
            onClick={granted ? onRevoke : onGrant}
          >
            {granted ? "Revoke" : "Allow commands"}
          </Button>
        </div>
      )}
      {reachable && !isThisDevice && (
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            void navigate({
              to: "/devices/$deviceId",
              params: { deviceId: device.deviceId },
            })
          }
        >
          View forest
          <ArrowRight />
        </Button>
      )}
    </div>
  );
}

// This device's name, editable inline. The saved name is the metadata the
// credential store keeps, so a rename survives a relaunch even before a
// future slice pushes it to the relay.
function DeviceNameField({ deviceName }: { deviceName: string }) {
  const setDeviceName = useSetDeviceName();
  const [draft, setDraft] = useState(deviceName);

  // Keep the draft in step when the stored name changes underneath us (a
  // broadcast from another window, or the mutation settling).
  useEffect(() => setDraft(deviceName), [deviceName]);

  const trimmed = draft.trim();
  const canSave =
    trimmed.length > 0 && trimmed !== deviceName && !setDeviceName.isPending;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="text-xs text-muted-foreground" htmlFor="device-name">
        This device
      </label>
      <Input
        id="device-name"
        type="text"
        value={draft}
        disabled={setDeviceName.isPending}
        onChange={(e) => setDraft(e.target.value)}
        aria-label="This device name"
        className="min-w-0 flex-1 px-2.5 py-1.5 text-sm"
      />
      <Button
        variant="outline"
        size="sm"
        disabled={!canSave}
        onClick={() => setDeviceName.mutate(trimmed)}
      >
        Rename
      </Button>
    </div>
  );
}

// Shorten a long account id for display while keeping enough on each end
// to recognise it. Short ids and the empty signed-out case pass through.
function abbreviateId(id: string): string {
  if (id === "") return "(no id)";
  if (id.length <= 16) return id;
  return `${id.slice(0, 10)}…${id.slice(-4)}`;
}
