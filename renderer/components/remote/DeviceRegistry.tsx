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
import { credentialRevoked } from "@shared/remote/supervisor";
import { useIsMutating } from "@tanstack/react-query";
import { errorMessageOf } from "@shared/errors";
import { isHubRefusal } from "@shared/account/service";
import { ClerkSignOutButton } from "@/components/account/ClerkSignOutButton";
import { ErrorBanner } from "@/components/ui/error-banner";
import {
  useAccountDevices,
  useLocalDevice,
  useRevokeDevice,
  useWatchCommandAccessChanges,
} from "@/hooks/account/useAccount";
import {
  CLERK_SIGN_OUT_KEY,
  useAccountIdentity,
  useClerkSessionMissing,
} from "@/hooks/account/useClerkAccount";
import {
  commandAccessOf,
  usePeerCommandAccess,
} from "@/hooks/remote/useCommandAccess";
import { useRemoteDevices } from "@/hooks/remote/useRemoteDevices";
import {
  useHubBlock,
  useHubStatus,
  useTunnelState,
} from "@/hooks/remote/useHubStatus";
import { useNow } from "@/hooks/ui/useNow";
import { abbreviateId } from "@/lib/abbreviateId";
import { localDeviceId } from "@/lib/queryKeys";
import { ClerkSignInButton } from "@/components/account/ClerkSignInButton";
import { DeviceRegistryRow } from "./DeviceRegistryRow";
import { useHostChipIndex } from "./deviceHostChips";
import { deviceRowStatus } from "./deviceRegistryStatus";

export function DeviceRegistry({ accountId }: { accountId: string }) {
  useWatchCommandAccessChanges();
  const local = useLocalDevice();
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
  // This device's own row reads its whole socket. The banner reads the
  // narrower block selector so it does not re-render on roster news.
  const socket = useHubStatus()?.socket ?? null;
  const block = useHubBlock();
  // A blocked socket is the one failure the hub explains itself, and
  // every list this page asks for comes back refused meanwhile, so the
  // registry tells that story here instead of leaving the generic
  // refusal line to imply a hub problem. A revoked device is already
  // being signed out by ClerkAccountSync, so that case says so. Any
  // other block keeps the hub's words.
  const blockedMessage =
    block === null
      ? null
      : credentialRevoked(block)
        ? "This device was removed from the account, so it is signing out."
        : block.message;
  const hosts = useHostChipIndex(localDeviceId);
  const now = useNow();
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
      // This device's name and icon are the copies it keeps of the
      // hub's, current the moment a change here lands. The row shows
      // the ones every other surface of this device draws.
      name: isThisDevice ? local.name : device.name,
      icon: isThisDevice ? local.icon : device.icon,
      status: deviceRowStatus(device, isThisDevice, hubDevice, socket, now),
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

      {/* One slot for what is wrong with this device's sign-in, and
          the way back sits in it because that is where the bad news
          is. Blocked outranks a missing session: a device removed
          from the account has nothing left to keep. */}
      {blockedMessage !== null ? (
        // The button re-enrolls this machine (the Clerk session
        // outlives a revoked device credential), which is the way back
        // if the automatic sign-out did not land.
        <SignInBanner>{blockedMessage}</SignInBanner>
      ) : (
        <SessionMissingBanner />
      )}

      {devicesQuery.isLoading ? (
        <p className="text-xs text-muted-foreground/70">
          Loading devices&hellip;
        </p>
      ) : devicesQuery.isError ? (
        // A failed list is unknown, not empty, so no "No devices yet"
        // under it. Nothing at all when the banner above already named
        // the cause: the refusal line would restate it in vaguer words
        // and read as a second, separate problem.
        blockedMessage === null && (
          <ErrorBanner>{describeListError(devicesQuery.error)}</ErrorBanner>
        )
      ) : rows.length === 0 ? (
        <p className="text-xs text-muted-foreground/70">No devices yet.</p>
      ) : (
        <ul className="divide-y divide-border">
          {rows.map(
            ({
              device,
              isThisDevice,
              name,
              icon,
              status,
              access,
              appVersion,
            }) => (
              <DeviceRegistryRow
                key={device.deviceId}
                device={device}
                isThisDevice={isThisDevice}
                name={name}
                icon={icon}
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
// reads the email (or name) Clerk knows. With no profile to read (still
// loading, or no session at all) the line names the account by its
// abbreviated id and does not call that "signed in". A leaf, like the
// sign-out button beside it, so Clerk's session churn re-renders one
// span and not the registry.
function AccountIdentity({ accountId }: { accountId: string }) {
  const person = useAccountIdentity();
  return (
    <p className="text-xs text-muted-foreground">
      {person === null ? "Account" : "Signed in as"}{" "}
      <span className="font-medium text-foreground select-text">
        {person ?? abbreviateId(accountId)}
      </span>
    </p>
  );
}

// The Clerk session is gone while the device credential, independent
// of it, still holds the device on the account: the sign-in expired
// while the app was closed, or its token store went (a keychain reset,
// a pre-Clerk upgrade), which ClerkAccountSync leaves alone on purpose.
// The copy claims only what is known, not which. The way back is a
// sign-in (as the same person: another account would re-enroll the
// device under it), and the sign-out in the caption still works
// without a session. A leaf, so Clerk's churn stays out of the
// registry. Quiet while a sign-out runs: Clerk drops its session
// before the hub revoke lands, and that gap is not this state.
function SessionMissingBanner() {
  const sessionMissing = useClerkSessionMissing();
  const signingOut = useIsMutating({ mutationKey: CLERK_SIGN_OUT_KEY }) > 0;
  if (!sessionMissing || signingOut) return null;
  return (
    <SignInBanner>
      This device is still on the account, but you are no longer signed in. Sign
      in again as the same person to keep it there, or sign out to remove it.
    </SignInBanner>
  );
}

// The banner shape both sign-in problems share: the sentence, and the
// button beside it.
function SignInBanner({ children }: { children: React.ReactNode }) {
  return (
    <ErrorBanner className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
      <span className="min-w-0 flex-1 basis-64">{children}</span>
      <ClerkSignInButton />
    </ErrorBanner>
  );
}
