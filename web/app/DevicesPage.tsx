// "/devices" on the web: the account's machines, wearing the desktop
// Devices page's chrome (PageShell, the "devices" wallpaper zone,
// Account over Devices sections). Data comes through the same hooks the
// desktop uses (useAccount) plus the remote device registry the relay
// sync maintains, so status semantics cannot drift between the two
// clients. Web-specific substance: the deployment access banner, the
// honest relay reachability messages, and per-device account-level
// revoke (a browser cannot grant command access, so no grant toggles).
import { useEffect, useState, useSyncExternalStore } from "react";
import { MonitorSmartphone, TreePine } from "lucide-react";
import { errorMessageOf } from "@shared/errors";
import type { AccountStatus } from "@shared/ipc/modules/account";
import type { RelayStatus } from "@shared/ipc/modules/relay";
import type { DeviceInfo } from "@shared/relay/protocol";
import { Button } from "@/components/ui/button";
import { ConfirmDestructiveButton } from "@/components/ui/confirm-destructive-button";
import { ErrorBanner } from "@/components/ui/error-banner";
import { SectionHeading } from "@/components/ui/section-heading";
import {
  DeviceNameField,
  DeviceRenameButton,
} from "@/components/remote/DeviceNameField";
import { DeviceStatusDot } from "@/components/remote/DeviceStatusDot";
import { PageShell } from "@/components/shared/PageShell";
import {
  useAccountDevices,
  useAccountStatus,
  useRevokeDevice,
} from "@/hooks/account/useAccount";
import { useClerkSignOut } from "@/hooks/account/useClerkAccount";
import { useRelayStatus } from "@/hooks/remote/useRelayStatus";
import { useRemoteDevices } from "@/hooks/remote/useRemoteDevices";
import { useConfirmTwice } from "@/hooks/ui/useConfirmTwice";
import { abbreviateId } from "@/lib/abbreviateId";
import { deviceStatusView } from "@/lib/remote/deviceStatus";
import { formatRelativeTime } from "@/lib/relativeTime";
import { isFetchFailure, isRelayRefusedError } from "../account/webAccess";
import { webBridge } from "../bridge/install";
import { navigateTo, redirectTo, webPaths } from "./nav";

function useWebAccess() {
  const store = webBridge().webAccess;
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

export function DevicesPage() {
  const { data: status, isPending: statusPending } = useAccountStatus();
  const signedIn = status?.signedIn === true;

  useEffect(() => {
    if (!statusPending && !signedIn) redirectTo(webPaths.login);
  }, [statusPending, signedIn]);

  return (
    <PageShell
      page="devices"
      eyebrow="Shigoto no Mori"
      title="Devices"
      watermark="機器"
      gap="gap-10"
    >
      {statusPending || !signedIn ? (
        <p className="text-sm text-muted-foreground">Loading&hellip;</p>
      ) : (
        <DevicesBody status={status} />
      )}
    </PageShell>
  );
}

// The signed-in page body, split out so its hooks only run once the
// status guard above has passed and the page shell stays a flat
// two-branch render.
function DevicesBody({ status }: { status: AccountStatus }) {
  const devices = useAccountDevices();
  const webAccess = useWebAccess();
  const relayStatus = useRelayStatus();

  return (
    <>
      <section className="space-y-3">
        <div>
          <SectionHeading className="mb-1">Account</SectionHeading>
          <p className="text-xs text-muted-foreground">
            Signed in as{" "}
            <span className="font-mono text-foreground">
              {abbreviateId(status.accountId)}
            </span>
            . This browser is enrolled as a device of its own. Removing it below
            signs it out.
          </p>
        </div>
        <BrowserNameField deviceName={status.deviceName} />
      </section>

      <section className="space-y-3">
        <SectionHeading>Devices</SectionHeading>

        {webAccess.kind === "blocked" && (
          <ErrorBanner>
            The relay refused this request ({webAccess.message}). This
            deployment cannot serve the device list until the relay accepts it.
          </ErrorBanner>
        )}

        {devices.isError && (
          <ErrorBanner>{reachabilityMessage(devices.error)}</ErrorBanner>
        )}

        {devices.isPending ? (
          <p className="text-sm text-muted-foreground">
            Loading devices&hellip;
          </p>
        ) : devices.data !== undefined && devices.data.length > 0 ? (
          <div className="divide-y divide-border overflow-hidden rounded-md border border-border">
            {devices.data.map((info) => (
              <DeviceRow
                key={info.deviceId}
                info={info}
                relayStatus={relayStatus}
              />
            ))}
          </div>
        ) : devices.isError ? null : (
          <div className="rounded-md border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
            No devices enrolled on this account yet. Sign in from the desktop
            app to enroll a machine.
          </div>
        )}
      </section>
    </>
  );
}

// This browser's name with its Rename trigger inline beside it (the
// desktop registry puts the same trigger with the row's actions
// instead), so the flag the two share lives here.
function BrowserNameField({ deviceName }: { deviceName: string }) {
  const [editing, setEditing] = useState(false);
  return (
    <span className="flex min-w-0 items-center gap-1">
      <DeviceNameField
        deviceName={deviceName}
        label="This browser"
        editing={editing}
        onEditingChange={setEditing}
      />
      {!editing && (
        <DeviceRenameButton
          label="This browser"
          onClick={() => setEditing(true)}
        />
      )}
    </span>
  );
}

// One honest sentence per failure shape. A browser cannot tell a
// refusing relay from an unreachable one when the response carries no
// CORS headers, so the fetch-failure branch names both possibilities
// instead of guessing.
function reachabilityMessage(error: unknown): string {
  if (isRelayRefusedError(error)) {
    return "The relay refused this request, so the device list is unavailable.";
  }
  if (isFetchFailure(error)) {
    return (
      "Couldn't reach the relay. Either you are offline, or this " +
      "deployment's relay URL does not point at a reachable Worker."
    );
  }
  return `Couldn't load the device list: ${errorMessageOf(error)}`;
}

function DeviceRow({
  info,
  relayStatus,
}: {
  info: DeviceInfo;
  relayStatus: RelayStatus | null;
}) {
  const isSelf = info.deviceId === window.api.deviceId;
  const remoteDevices = useRemoteDevices();
  const entry = remoteDevices.find((d) => d.deviceId === info.deviceId);
  // Own row: the relay socket IS this device's presence. Peers: the
  // registry's derived status, or the socket phase before the registry
  // catches up.
  const supervisorStatus = isSelf
    ? (relayStatus?.socket ?? { phase: "idle" as const })
    : (entry?.status ?? { phase: "stopped" as const });
  // The forest gate is REACHABLE (connected, or online in the roster),
  // never `connected`: only entering the forest dials a direct
  // session, so gating on an established one would leave the button
  // permanently disabled (nothing else on this page opens a session).
  const { reachable } = deviceStatusView(supervisorStatus);

  return (
    <div className="flex flex-wrap items-center gap-3 px-3 py-2.5">
      <MonitorSmartphone className="size-4 shrink-0 text-muted-foreground" />
      {/* Grows but never shrinks below a readable name. On a narrow
          screen the controls wrap under it instead of crushing it. */}
      <div className="flex min-w-0 flex-[1_1_10rem] flex-col">
        <span className="flex items-center gap-2 text-sm">
          <span className="truncate font-medium">{info.name}</span>
          {isSelf && (
            <span className="shrink-0 rounded-sm bg-secondary px-1.5 py-0.5 text-[10px] text-secondary-foreground">
              This browser
            </span>
          )}
        </span>
        <span className="truncate text-xs text-muted-foreground">
          {info.platform}
          {info.lastSeenAt !== null &&
            ` · last seen ${formatRelativeTime(info.lastSeenAt)}`}
        </span>
      </div>
      <DeviceStatusDot status={supervisorStatus} />
      {!isSelf && (
        <Button
          variant="outline"
          size="sm"
          disabled={!reachable}
          title={
            reachable ? undefined : "This device isn't reachable right now"
          }
          onClick={() => navigateTo(webPaths.deviceForest(info.deviceId))}
        >
          <TreePine />
          View forest
        </Button>
      )}
      {isSelf ? (
        <SelfRevokeButton />
      ) : (
        <PeerRevokeButton deviceId={info.deviceId} />
      )}
    </div>
  );
}

// Revoking THIS browser must end the Clerk session first (with the
// session alive, ClerkAccountSync would immediately re-enroll the
// cleared credential), and the sign-out path (Clerk end, relay revoke,
// local clear) is exactly the self-revoke semantics. Split from the
// peer button so only the self row touches a Clerk hook (rows exist
// only when enrolled, which implies a mounted provider).
function SelfRevokeButton() {
  const signOut = useClerkSignOut();
  const confirm = useConfirmTwice();
  return (
    <ConfirmDestructiveButton
      armed={confirm.armed}
      pending={signOut.isPending}
      pendingLabel="Removing…"
      idleLabel="Remove and sign out"
      onClick={() => confirm.trigger(() => signOut.mutate())}
    />
  );
}

// The same hook the desktop registry revokes through: the bridge serves
// account:revokeDevice from the very function its own revokeDevice
// method calls, so the two clients cannot drift. No onSuccess
// invalidation there either -- the revoke ends with the bridge's
// account.changed broadcast, and useWatchAccountChanges (mounted in the
// shell) invalidates the whole account prefix off it.
function PeerRevokeButton({ deviceId }: { deviceId: string }) {
  const revoke = useRevokeDevice();
  const confirm = useConfirmTwice();
  return (
    <ConfirmDestructiveButton
      armed={confirm.armed}
      pending={revoke.isPending}
      pendingLabel="Removing…"
      idleLabel="Remove from account"
      onClick={() => confirm.trigger(() => revoke.mutate(deviceId))}
    />
  );
}
