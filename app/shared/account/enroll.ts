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
  const accountId = deriveAccountId(token);
  deps.store.write({
    credential: enrollment.credential,
    accountId,
    deviceName,
    ...(deviceIcon === null ? {} : { deviceIcon }),
    hubName: deviceName,
    hubIcon: fields.icon,
    // A re-enrollment under the same account keeps the command-access
    // switch. Another account starts with it off.
    ...(stored?.accountId === accountId && stored.acceptsCommands === true
      ? { acceptsCommands: true }
      : {}),
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

// A change to a device's name, its icon, or both.
export type DeviceFields = { name?: string; icon?: DeviceIcon };

// A device's name and icon live on the hub, so any device of the
// account can change them, this one or a peer, online or not. The
// change is the hub write, awaited: one the hub never took did not
// happen, so it throws rather than leave a name or mark only this
// device shows. A change to THIS device is kept locally too, so the
// status it resolves to already wears it. A peer takes its change from
// the hub on its next registry read (syncHubDevice).
export async function updateDevice(
  deps: Pick<
    EnrollDeviceDeps,
    "service" | "store" | "deviceId" | "detectedIcon"
  >,
  record: StoredAccount,
  deviceId: string,
  patch: DeviceFields,
): Promise<void> {
  // A stale push of this device's own values still out lands first, or
  // it could land over this change.
  const pending = stalePushes.get(deviceId);
  if (pending !== undefined) {
    await pending;
    record = deps.store.read() ?? record;
  }
  await deps.service.update(record.credential, deviceId, patch);
  if (deviceId !== deps.deviceId) return;
  keepFields(deps, record, {
    ...(patch.name === undefined
      ? {}
      : { deviceName: patch.name, hubName: patch.name }),
    ...(patch.icon === undefined
      ? {}
      : { deviceIcon: pickOf(deps, patch.icon), hubIcon: patch.icon }),
  });
}

// A change to this device's name made here without the hub (main's
// default-name migration). The hub still holds the name it left, unless
// it moved since, so the next registry read pushes the new one over it
// (syncHubDevice).
export function renameLocally(
  store: AccountStore,
  record: StoredAccount,
  name: string,
): StoredAccount {
  const renamed = {
    ...record,
    deviceName: name,
    hubName: record.hubName ?? record.deviceName,
  };
  store.write(renamed);
  return renamed;
}

// Squares this device's name and icon with the registry the hub just
// listed. hubName and hubIcon, what the hub last held as far as this
// device knows, tell the two ways a field can differ apart:
// - The hub moved: another device changed this one, adopted here.
// - The hub did not move but this device did: a default name it
//   migrated forward (renameLocally), a detection that improved with an
//   upgrade (it has no pick, so it wears what it detects now). The hub
//   copy is stale and gets this device's value, best-effort, recorded
//   as the hub's once it lands.
// A record from before these fields existed has no answer, so each
// field takes the likelier one. A name only ever changed on this
// device before, so a hub name that differs is a peer's rename and is
// adopted. An icon differs most likely by a detection that improved
// since the enrollment, so the listing is taken as where the hub was
// and this device's icon corrects it rather than being pinned.
// `listedUnder` is the record the listing was fetched under: a change
// here that raced the read wins over it (keepFields). Resolves true
// when the name or icon this device wears changed.
export function syncHubDevice(
  deps: Pick<
    EnrollDeviceDeps,
    "service" | "store" | "deviceId" | "detectedIcon"
  >,
  listedUnder: StoredAccount,
  devices: readonly DeviceInfo[],
): boolean {
  const listed = devices.find((device) => device.deviceId === deps.deviceId);
  if (listed === undefined) return false;
  const changes: HubFieldChanges = {
    hubName: listed.name,
    hubIcon: listed.icon,
  };
  const stale: DeviceFields = {};
  if (listedUnder.hubName !== listed.name) {
    changes.deviceName = listed.name;
  } else if (listedUnder.deviceName !== listed.name) {
    stale.name = listedUnder.deviceName;
  }
  if (listed.icon !== (listedUnder.hubIcon ?? listed.icon)) {
    changes.deviceIcon = pickOf(deps, listed.icon);
  } else if (wornIcon(deps, listedUnder) !== listed.icon) {
    stale.icon = wornIcon(deps, listedUnder);
  }
  const worn = keepFields(deps, listedUnder, changes);
  if (
    (stale.name !== undefined || stale.icon !== undefined) &&
    !stalePushes.has(deps.deviceId)
  ) {
    stalePushes.set(
      deps.deviceId,
      pushStale(deps, listedUnder.credential, stale).finally(() =>
        stalePushes.delete(deps.deviceId),
      ),
    );
  }
  return worn;
}

// The stale push in flight per device, so the registry reads that land
// while one is out (a focus, several windows) do not repeat it, and a
// change made here waits it out (updateDevice).
const stalePushes = new Map<string, Promise<void>>();

// The best-effort push of this device's own values over a stale hub
// copy, recorded as the hub's once it lands, so a peer that later
// changes a field back to the old value reads as the hub moving. A
// value this device stopped wearing meanwhile is not recorded.
async function pushStale(
  deps: Pick<
    EnrollDeviceDeps,
    "service" | "store" | "deviceId" | "detectedIcon"
  >,
  credential: string,
  stale: DeviceFields,
): Promise<void> {
  try {
    await deps.service.update(credential, deps.deviceId, stale);
  } catch (error) {
    console.warn(
      `[account] could not push this device's name or icon to the device hub: ${errorMessageOf(error)}`,
    );
    return;
  }
  const current = deps.store.read();
  if (current === null || current.credential !== credential) return;
  keepFields(deps, current, {
    ...(current.deviceName === stale.name ? { hubName: stale.name } : {}),
    ...(wornIcon(deps, current) === stale.icon ? { hubIcon: stale.icon } : {}),
  });
}

// The icon this device wears: its owner's pick, else what it detects.
// effectiveDeviceIcon's rule for a signed-in record, without its read
// of the signed-out remainder.
function wornIcon(
  deps: Pick<EnrollDeviceDeps, "detectedIcon">,
  record: StoredAccount,
): DeviceIcon {
  return record.deviceIcon ?? deps.detectedIcon;
}

// The detected icon is no pick, so a device put back to its default
// carries no override a later, better detection could not move.
function pickOf(
  deps: Pick<EnrollDeviceDeps, "detectedIcon">,
  icon: DeviceIcon,
): DeviceIcon | undefined {
  return icon === deps.detectedIcon ? undefined : icon;
}

// The fields keepFields may move: what this device wears, and what it
// last saw on the hub.
const HUB_FIELDS = ["deviceName", "deviceIcon", "hubName", "hubIcon"] as const;

// A present deviceIcon key set to undefined drops the pick.
type HubFieldChanges = Partial<
  Pick<StoredAccount, (typeof HUB_FIELDS)[number]>
>;

// Writes `changes` over the record the caller started from. Re-reads
// before writing, since the caller may have awaited the hub in between:
// a sign-out or re-enrollment meanwhile, or a change or sync that
// already moved one of these fields, wins over this write. Resolves
// true when the name or icon this device wears changed.
function keepFields(
  deps: Pick<EnrollDeviceDeps, "store">,
  startedFrom: StoredAccount,
  changes: HubFieldChanges,
): boolean {
  const moves = (key: keyof HubFieldChanges) =>
    key in changes && changes[key] !== startedFrom[key];
  if (!HUB_FIELDS.some(moves)) return false;
  const current = deps.store.read();
  if (
    current === null ||
    current.credential !== startedFrom.credential ||
    HUB_FIELDS.some((key) => current[key] !== startedFrom[key])
  ) {
    return false;
  }
  const next: StoredAccount = { ...current, ...changes };
  if (next.deviceIcon === undefined) delete next.deviceIcon;
  deps.store.write(next);
  return moves("deviceName") || moves("deviceIcon");
}
