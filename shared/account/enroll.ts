// The enrollment and sign-out orchestration both shells share, the
// successor to the deleted PKCE login flows: the desktop handler
// (main/ipc/modules/account.ts) and the web bridge
// (web/ipc/register.ts) differ only in their platform label,
// device-name default and store backing. Pure like the rest of
// shared/account/ (every dependency is an injected seam:
// AccountService, AccountStore, AccountServiceConfig), so the
// account check script drives both paths with stubs.
import { errorMessageOf } from "../errors";
import type { DeviceInfo, EnrollResponse } from "../hub/protocol";
import { HubRequestError, isHubRefusal, type AccountService } from "./service";
import type { AccountStore, StoredAccount } from "./credentialStore";
import { isConfigured, type AccountServiceConfig } from "./serviceConfig";
import { deriveAccountId } from "./token";
import type { DeviceIcon } from "./deviceIcon";

type EnrollDeviceDeps = {
  config: AccountServiceConfig;
  service: AccountService;
  store: AccountStore;
  deviceId: string;
  // The name this device enrolls under when the store holds none yet.
  fallbackDeviceName: string;
  // Opaque platform label the device hub stores beside the device
  // (os.platform() on desktop, WEB_PLATFORM in a browser).
  platform: string;
  // What this device detected itself to be, the icon it enrolls under
  // unless its owner picked one (the store's deviceIcon).
  detectedIcon: DeviceIcon;
};

// The icon this device reports to the hub: the owner's pick where one
// is stored (or remembered across a sign-out), else what the device
// detected. One rule for the enroll, the pick's push and every status
// read, so the registry never sees one answer at enroll and another
// after. Takes the record the caller already read: a read is a file
// parse plus a keychain decrypt, not something to repeat per field.
export function effectiveDeviceIcon(
  record: StoredAccount | null,
  store: Pick<AccountStore, "rememberedDeviceIcon">,
  detectedIcon: DeviceIcon,
): DeviceIcon {
  return record?.deviceIcon ?? store.rememberedDeviceIcon() ?? detectedIcon;
}

// Exchanges a fresh Clerk session token (minted by the renderer's
// ClerkAccountSync off the live session) for the hub device
// credential and persists it with the token's account id.
export async function enrollDevice(
  deps: EnrollDeviceDeps,
  token: string,
): Promise<void> {
  if (!isConfigured(deps.config)) {
    throw new Error("the device hub is not configured on this build");
  }
  const stored = deps.store.read();
  const deviceName =
    stored?.deviceName ??
    deps.store.rememberedDeviceName() ??
    deps.fallbackDeviceName;
  // The pick alone, for the store: the wire gets the effective icon.
  const deviceIcon = stored?.deviceIcon ?? deps.store.rememberedDeviceIcon();
  const fields = {
    deviceId: deps.deviceId,
    name: deviceName,
    platform: deps.platform,
    icon: effectiveDeviceIcon(stored, deps.store, deps.detectedIcon),
  };
  let enrollment: EnrollResponse;
  try {
    enrollment = await deps.service.enroll(token, fields);
  } catch (error) {
    // The hub still lists this device under another account, from a
    // sign-out whose revoke never reached it: deliver that revoke and
    // try once more. Only here, so a parked revoke that cannot be
    // delivered (offline) never stalls a sign-in that would have
    // worked. A re-enroll under the SAME account rotates the row, and
    // the parked credential is dead either way (write() drops it).
    if (
      !(error instanceof HubRequestError && error.status === 409) ||
      !(await retryParkedRevoke(deps))
    ) {
      throw error;
    }
    enrollment = await deps.service.enroll(token, fields);
  }
  deps.store.write({
    credential: enrollment.credential,
    accountId: deriveAccountId(token),
    deviceName,
    ...(deviceIcon === null ? {} : { deviceIcon }),
    hubIcon: fields.icon,
  });
}

// How long the sign-out waits on the hub's revoke before signing out
// locally anyway. Everything the sign-out tears down (the listener,
// the tunnel, the mirrors, the forwards) waits behind this call, so
// on a black-holed network it must give up in seconds, not at the
// platform's own fetch timeout minutes later.
export const SIGN_OUT_REVOKE_TIMEOUT_MS = 10_000;

// Best-effort revoke of THIS device on the device hub, then the local
// credential clear. The revoke failure is reported, not thrown,
// because local sign-out must always succeed, even offline.
export async function signOutDevice(deps: {
  config: AccountServiceConfig;
  service: AccountService;
  store: AccountStore;
  deviceId: string;
  onRevokeFailure?: (error: unknown) => void;
}): Promise<void> {
  const record = deps.store.read();
  if (record !== null && isConfigured(deps.config)) {
    try {
      await deps.service.revoke(
        record.credential,
        deps.deviceId,
        AbortSignal.timeout(SIGN_OUT_REVOKE_TIMEOUT_MS),
      );
    } catch (error) {
      deps.onRevokeFailure?.(error);
      // A refusal means the hub already does not honor the credential
      // (revoked elsewhere, rotated away): nothing to deliver later.
      // Anything else (offline, hub down, the timeout) leaves the
      // device enrolled on the hub with a credential only this machine
      // holds, so it is parked for retryParkedRevoke rather than
      // dropped: an undelivered revoke is what strands the row (and
      // the next account's enroll on a 409) for good.
      if (!isHubRefusal(error)) {
        deps.store.park(record);
        return;
      }
    }
  }
  deps.store.clear();
}

// Delivers the revoke a sign-out parked, if any: at boot (both
// shells) and on an enrollment the hub refused for it. A delivered or
// refused revoke clears the parking, anything else keeps it for the
// next try. Never throws. Resolves to whether the parking was cleared.
export async function retryParkedRevoke(deps: {
  config: AccountServiceConfig;
  service: AccountService;
  store: AccountStore;
  deviceId: string;
}): Promise<boolean> {
  const parked = deps.store.readParked();
  if (parked === null || !isConfigured(deps.config)) return false;
  try {
    await deps.service.revoke(
      parked.credential,
      deps.deviceId,
      AbortSignal.timeout(SIGN_OUT_REVOKE_TIMEOUT_MS),
    );
  } catch (error) {
    if (!isHubRefusal(error)) return false;
  }
  deps.store.clearParked();
  return true;
}

// A rename, both halves: the local store write (the name every status
// read reports), then the hub push, best-effort like the sign-out
// revoke, so the registry every other device lists carries the new
// name at once. Signed out there is nothing to rename: the name is
// the default until the next sign-in. The push is fire-and-forget on
// purpose: an unreachable hub must not hold the caller, and a peer
// that misses it sees the stored name at this device's next
// enrollment anyway. Resolves true when a name was written.
export function renameDevice(
  deps: Pick<EnrollDeviceDeps, "config" | "service" | "store" | "deviceId">,
  name: string,
): boolean {
  const record = deps.store.read();
  if (record === null) return false;
  deps.store.write({ ...record, deviceName: name });
  pushDeviceUpdate(deps, record.credential, { name });
  return true;
}

// A device's icon lives on the hub, so any device of the account can
// pick it, this one or a peer, online or not. The pick is the hub
// write, awaited: one the hub never took did not happen, so it throws
// rather than leave a mark only this device draws. A pick for THIS
// device is kept locally too, so the status it resolves to already
// wears it. A peer takes its new icon from the hub on its next
// registry read (syncHubDeviceIcon).
export async function setDeviceIcon(
  deps: Pick<
    EnrollDeviceDeps,
    "service" | "store" | "deviceId" | "detectedIcon"
  >,
  record: StoredAccount,
  target: { deviceId: string; icon: DeviceIcon },
): Promise<void> {
  await deps.service.update(record.credential, target.deviceId, {
    icon: target.icon,
  });
  if (target.deviceId === deps.deviceId) {
    keepIcon(deps, record, pickOf(deps, target.icon), target.icon);
  }
}

// Squares this device's icon with the registry the hub just listed.
// hubIcon, the icon the hub last held as far as this device knows,
// tells the two ways they can differ apart:
// - The hub moved: another device picked for this one, adopted here.
// - The hub did not move but this device did: its detection improved
//   with an upgrade (it has no pick, so it wears what it detects now).
//   The hub copy is stale and gets this device's icon, best-effort.
// A record from before hubIcon existed takes the listed icon as where
// the hub was, so an upgrade corrects a stale detection rather than
// pinning it as a pick. `listedUnder` is the record the listing was
// fetched under: a pick here that raced the read wins over it
// (keepIcon). Resolves true when the icon this device wears changed.
export function syncHubDeviceIcon(
  deps: Pick<
    EnrollDeviceDeps,
    "service" | "store" | "deviceId" | "detectedIcon"
  >,
  listedUnder: StoredAccount,
  devices: readonly DeviceInfo[],
): boolean {
  const listed = devices.find(
    (device) => device.deviceId === deps.deviceId,
  )?.icon;
  if (listed === undefined) return false;
  if (listed !== (listedUnder.hubIcon ?? listed)) {
    return keepIcon(deps, listedUnder, pickOf(deps, listed), listed);
  }
  const worn = listedUnder.deviceIcon ?? deps.detectedIcon;
  if (worn === listed) {
    keepIcon(deps, listedUnder, listedUnder.deviceIcon, listed);
    return false;
  }
  void deps.service
    .update(listedUnder.credential, deps.deviceId, { icon: worn })
    .then(() => keepIcon(deps, listedUnder, listedUnder.deviceIcon, worn))
    .catch((error: unknown) => {
      console.warn(
        `[account] could not push this device's icon to the device hub: ${errorMessageOf(error)}`,
      );
    });
  return false;
}

// The detected icon is no pick, so a device put back to its default
// carries no override a later, better detection could not move.
function pickOf(
  deps: Pick<EnrollDeviceDeps, "detectedIcon">,
  icon: DeviceIcon,
): DeviceIcon | undefined {
  return icon === deps.detectedIcon ? undefined : icon;
}

// Stores this device's pick and the hub's icon against the record the
// caller started from. Re-reads before writing, since the caller may
// have awaited the hub in between: a sign-out or re-enrollment
// meanwhile, or a pick or sync that already moved either field, wins
// over this write. Resolves true when the stored pick changed.
function keepIcon(
  deps: Pick<EnrollDeviceDeps, "store">,
  startedFrom: StoredAccount,
  pick: DeviceIcon | undefined,
  hubIcon: DeviceIcon,
): boolean {
  if (startedFrom.deviceIcon === pick && startedFrom.hubIcon === hubIcon) {
    return false;
  }
  const current = deps.store.read();
  if (
    current === null ||
    current.credential !== startedFrom.credential ||
    current.deviceIcon !== startedFrom.deviceIcon ||
    current.hubIcon !== startedFrom.hubIcon
  ) {
    return false;
  }
  const { deviceIcon: _dropped, ...rest } = current;
  deps.store.write({
    ...rest,
    hubIcon,
    ...(pick === undefined ? {} : { deviceIcon: pick }),
  });
  return startedFrom.deviceIcon !== pick;
}

function pushDeviceUpdate(
  deps: Pick<EnrollDeviceDeps, "config" | "service" | "deviceId">,
  credential: string,
  patch: Parameters<AccountService["update"]>[2],
): void {
  if (!isConfigured(deps.config)) return;
  void deps.service
    .update(credential, deps.deviceId, patch)
    .catch((error: unknown) => {
      console.warn(
        `[account] could not push the device update to the device hub: ${errorMessageOf(error)}`,
      );
    });
}
