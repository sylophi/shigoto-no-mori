// The enrollment and sign-out orchestration both shells share, the
// successor to the deleted PKCE login flows: the desktop handler
// (main/ipc/modules/account.ts) and the web bridge
// (web/ipc/register.ts) differ only in their platform label,
// device-name default and store backing. Pure like the rest of
// shared/account/ (every dependency is an injected seam:
// AccountService, AccountStore, AccountServiceConfig), so the
// account check script drives both paths with stubs.
import { errorMessageOf } from "../errors";
import type { AccountService } from "./service";
import type { AccountStore } from "./credentialStore";
import { isConfigured, type AccountServiceConfig } from "./serviceConfig";
import { deriveAccountId } from "./token";

// The platform label a browser enrolls under, beside the desktop's
// os.platform() values. Producers (the web bridge, the lab) and the
// one consumer that branches on it (the registry row's traits) share
// this so a typo cannot silently turn a browser into a desktop row.
export const WEB_PLATFORM = "web";

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
  const deviceName = deps.store.read()?.deviceName ?? deps.fallbackDeviceName;
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
      await deps.service.revoke(record.credential, deps.deviceId);
    } catch (error) {
      deps.onRevokeFailure?.(error);
    }
  }
  deps.store.clear();
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
