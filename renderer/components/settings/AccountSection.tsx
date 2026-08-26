import { useEffect, useState } from "react";
import { LogIn, LogOut } from "lucide-react";
import type { DeviceInfo } from "@shared/relay/protocol";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SectionHeading } from "@/components/ui/section-heading";
import { StatusDot } from "@/components/ui/status-dot";
import {
  useAccountDevices,
  useAccountStatus,
  useSetDeviceName,
  useSignIn,
  useSignOut,
  useWatchAccountChanges,
} from "@/hooks/account/useAccount";

// "Account": sign in to the relay so this device can reach the account's
// other devices (v2 step 4, slice B). Three states: not configured (the
// owner has not set the SM_ACCOUNT_* env vars, so sign-in is impossible
// on this build), signed out (a Sign in button), and signed in (this
// device's identity plus the account's device registry, display only).
// Wiring the remote forest over the relay is a later slice, so the list
// is not clickable here.
export function AccountSection() {
  useWatchAccountChanges();
  const { data: status } = useAccountStatus();
  const signIn = useSignIn();
  const signOut = useSignOut();

  const signedIn = status?.signedIn === true;
  const devicesQuery = useAccountDevices(signedIn);

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
      ) : !status.configured ? (
        <p className="text-xs text-muted-foreground/70">
          Not configured on this build. The owner sets the relay and OAuth
          environment variables (<span className="font-mono">SM_ACCOUNT_*</span>
          ) before sign-in is available. No rebuild is needed once they are set.
        </p>
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
// platform plus device id as a muted sub-line. Display only until the
// relay-forest slice lands.
function DeviceRow({
  device,
  isThisDevice,
}: {
  device: DeviceInfo;
  isThisDevice: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-md border border-border px-3 py-2">
      <StatusDot tone={device.online ? "emerald" : "slate"} />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm">
          {device.name}
          {isThisDevice && (
            <span className="ml-2 text-xs text-muted-foreground">
              (this device)
            </span>
          )}
        </span>
        <span className="truncate font-mono text-[10px] text-muted-foreground">
          {device.platform} &middot; {device.deviceId}
        </span>
      </div>
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
