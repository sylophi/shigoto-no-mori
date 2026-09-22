// The enrollment and sign-out orchestration both shells share, the
// successor to the deleted PKCE login flows: the desktop handler
// (main/ipc/modules/account.ts) and the web bridge
// (web/ipc/register.ts) differ only in their platform label,
// device-name default and store backing. Pure like the rest of
// shared/account/ (every dependency is an injected seam:
// AccountService, AccountStore, AccountServiceConfig), so the
// account check script drives both paths with stubs.
import { errorMessageOf } from "../errors";
import { isHubRefusal, type AccountService } from "./service";
import type { AccountStore } from "./credentialStore";
import { isConfigured, type AccountServiceConfig } from "./serviceConfig";
import { deriveAccountId } from "./token";

// The platform label a browser enrolls under, beside the desktop's
// os.platform() values. Producers (the web bridge, the lab) and the
// one consumer that branches on it (the registry row's traits) share
// this so a typo cannot silently turn a browser into a desktop row.
export const WEB_PLATFORM = "web";

// Whether a device of this platform registers projects. The one trait
// a list filters on, here so the host's device roster (the CLI's
// cross-device verbs) and the renderer's lists cannot disagree.
export function hostsProjects(platform: string): boolean {
  return platform !== WEB_PLATFORM;
}

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
};

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
  // A revoke a sign-out could not deliver goes first: the hub still
  // lists this device under the old account, and refuses to enroll
  // the same device under another one until that row is gone.
  await retryParkedRevoke(deps);
  const deviceName =
    deps.store.read()?.deviceName ??
    deps.store.rememberedDeviceName() ??
    deps.fallbackDeviceName;
  const enrollment = await deps.service.enroll(token, {
    deviceId: deps.deviceId,
    name: deviceName,
    platform: deps.platform,
  });
  deps.store.write({
    credential: enrollment.credential,
    accountId: deriveAccountId(token),
    deviceName,
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

// Delivers the revoke a sign-out parked, if any: at boot and before
// an enrollment (both shells). A delivered or refused revoke clears
// the parking; anything else keeps it for the next try. Never throws,
// and a failure is not a reason to hold the caller up: the parked
// credential is dead to this device either way.
export async function retryParkedRevoke(deps: {
  config: AccountServiceConfig;
  service: AccountService;
  store: AccountStore;
  deviceId: string;
}): Promise<void> {
  const parked = deps.store.readParked();
  if (parked === null || !isConfigured(deps.config)) return;
  try {
    await deps.service.revoke(
      parked.credential,
      deps.deviceId,
      AbortSignal.timeout(SIGN_OUT_REVOKE_TIMEOUT_MS),
    );
    deps.store.clearParked();
  } catch (error) {
    if (isHubRefusal(error)) deps.store.clearParked();
  }
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
  if (!isConfigured(deps.config)) return true;
  void deps.service
    .rename(record.credential, deps.deviceId, name)
    .catch((error: unknown) => {
      console.warn(
        `[account] could not push the rename to the device hub: ${errorMessageOf(error)}`,
      );
    });
  return true;
}
