// The devices-first home: the account's enrolled devices with live
// relay presence, a per-device account-level revoke, and the door into
// each online device's read-only forest. Data comes through the same
// hooks the desktop settings use (useAccount) plus the remote device
// registry the relay sync maintains, so status semantics cannot drift
// between the two clients.
import { useEffect, useSyncExternalStore } from "react";
import { useMutation } from "@tanstack/react-query";
import { MonitorSmartphone, TreePine } from "lucide-react";
import { errorMessageOf } from "@shared/errors";
import type { RelayStatus } from "@shared/ipc/modules/relay";
import type { DeviceInfo } from "@shared/relay/protocol";
import { Button } from "@/components/ui/button";
import { ConfirmDestructiveButton } from "@/components/ui/confirm-destructive-button";
import { ErrorBanner } from "@/components/ui/error-banner";
import { DeviceStatusDot } from "@/components/remote/DeviceStatusDot";
import { PageHeader } from "@/components/shared/PageHeader";
import {
  useAccountDevices,
  useAccountStatus,
} from "@/hooks/account/useAccount";
import { useClerkSignOut } from "@/hooks/account/useClerkAccount";
import { useRelayStatus } from "@/hooks/remote/useRelayStatus";
import { useRemoteDevices } from "@/hooks/remote/useRemoteDevices";
import { useConfirmTwice } from "@/hooks/ui/useConfirmTwice";
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

  const devices = useAccountDevices(signedIn);
  const webAccess = useWebAccess();
  const relayStatus = useRelayStatus();

  if (statusPending || !signedIn) {
    return (
      <PageShell>
        <p className="text-sm text-muted-foreground">Loading…</p>
      </PageShell>
    );
  }

  return (
    <PageShell accountId={status?.accountId}>
      {webAccess.kind === "blocked" && (
        <ErrorBanner>
          The relay refused this request ({webAccess.message}). This deployment
          cannot serve the device list until the relay accepts it.
        </ErrorBanner>
      )}

      {devices.isError && (
        <ErrorBanner>{reachabilityMessage(devices.error)}</ErrorBanner>
      )}

      {devices.isPending ? (
        <p className="text-sm text-muted-foreground">Loading devices…</p>
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
          No devices enrolled on this account yet. Sign in from the desktop app
          to enroll a machine.
        </div>
      )}
    </PageShell>
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
    <div className="flex items-center gap-3 px-3 py-2.5">
      <MonitorSmartphone className="size-4 shrink-0 text-muted-foreground" />
      <div className="flex min-w-0 flex-1 flex-col">
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
      pendingLabel="Revoking…"
      idleLabel="Revoke and sign out"
      onClick={() => confirm.trigger(() => signOut.mutate())}
    />
  );
}

// No onSuccess invalidation: the revoke ends with the bridge's
// account.changed broadcast, and useWatchAccountChanges (mounted in
// the shell) invalidates the whole account prefix off it, exactly as
// useAccount.ts documents for the desktop mutations.
function PeerRevokeButton({ deviceId }: { deviceId: string }) {
  const revoke = useMutation({
    mutationFn: () => webBridge().revokeDevice(deviceId),
    meta: { errorTitle: "Couldn't revoke the device" },
  });
  const confirm = useConfirmTwice();
  return (
    <ConfirmDestructiveButton
      armed={confirm.armed}
      pending={revoke.isPending}
      pendingLabel="Revoking…"
      idleLabel="Revoke"
      onClick={() => confirm.trigger(() => revoke.mutate())}
    />
  );
}

function PageShell({
  accountId,
  children,
}: {
  accountId?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-full flex-col">
      <PageHeader
        eyebrow={accountId ? `Signed in as ${accountId}` : "Account"}
        title="Devices"
        watermark="端末"
        topPadding="pt-5"
      />
      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <div className="flex max-w-3xl flex-col gap-4">{children}</div>
      </div>
    </div>
  );
}
