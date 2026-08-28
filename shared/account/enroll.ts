// The enrollment and sign-out orchestration both shells share, the
// successor to the deleted PKCE login flows: the desktop handler
// (main/ipc/modules/account.ts) and the web bridge
// (web/bridge/createWebBridge.ts) differ only in their platform label,
// device-name default and store backing. Pure like the rest of
// shared/account/ — every dependency is an injected seam
// (AccountService, AccountStore, AccountServiceConfig) — so the
// account check script drives both paths with stubs.
import type { AccountService } from "./service";
import type { AccountStore } from "./credentialStore";
import { isConfigured, type AccountServiceConfig } from "./serviceConfig";
import { deriveAccountId } from "./token";

export type EnrollDeviceDeps = {
  config: AccountServiceConfig;
  service: AccountService;
  store: AccountStore;
  deviceId: string;
  // The name this device enrolls under when the store holds none yet.
  fallbackDeviceName: string;
  // Opaque platform label the relay stores beside the device
  // (os.platform() on desktop, "web" in a browser).
  platform: string;
};

// Exchanges a fresh Clerk session token (minted by the renderer's
// ClerkAccountSync off the live session) for the relay device
// credential and persists it with the token's account id.
export async function enrollDevice(
  deps: EnrollDeviceDeps,
  token: string,
): Promise<void> {
  if (!isConfigured(deps.config)) {
    throw new Error(
      "the relay account service is not configured on this build",
    );
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

// Best-effort revoke of THIS device on the relay, then the local
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
