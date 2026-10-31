// What the two shells a host runs under share of the account: the
// desktop's main (main/electron/account.ts) and the headless host's
// (headless/account.ts). The service's config, the account as the host
// is told it, and a nuke's sign-out.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";
import {
  isConfigured,
  mergeServiceEnv,
  resolveServiceConfig,
  type AccountServiceConfig,
} from "@shigomori/contracts/accountServiceConfig";
import { errorMessageOf } from "@shigomori/contracts/errors";
import type { AccountFacts } from "@shigomori/contracts/modules/session";
import type { AccountStore, StoredAccount } from "./credentialStore";
import { retryParkedRevoke, signOutDevice } from "./enroll";
import type { AccountService } from "./service";

// Three layers, lowest to highest precedence: the optional .env.local
// file (dev convenience), the account service values baked into the
// bundle when it was built, then real environment variables. The baked
// layer is what configures a shipped build: a packaged .app launched
// from Finder or the Dock inherits launchd's environment, not a
// shell's, so runtime process.env carries none of these. The env layer
// on top still lets an owner override a baked build.
//
// The web shell reads the same .env.local through Vite, so the filename
// is shared: changing it here strands vite.web.config.ts.
//
// The file read is gated behind !packaged for security: in a packaged
// build an attacker-planted .env.local in the launch directory could
// both enable sign-in and point the Clerk key/hub URL at hostile
// infrastructure, so a shipped build sources config ONLY from the
// values baked in at build time and real environment variables, neither
// of which a file can plant. The dev-convenience file stays in dev.
export function serviceConfigOf(packaged: boolean): AccountServiceConfig {
  let fileEnv: Record<string, string | undefined> = {};
  if (!packaged) {
    try {
      fileEnv = parseEnv(
        readFileSync(join(process.cwd(), ".env.local"), "utf8"),
      );
    } catch {
      // No dev file. Baked and environment values are the only sources.
    }
  }
  // __SM_ACCOUNT_BAKED_ENV__ is the vite.node.config.ts define, which
  // both shells' builds go through. It stays out of the pure contracts
  // module so accountServiceConfig.ts stays loadable under plain node,
  // where the Vite configs read it.
  return resolveServiceConfig(
    mergeServiceEnv(fileEnv, __SM_ACCOUNT_BAKED_ENV__, process.env),
  );
}

// The account as the host is to know it (host/process/account.ts),
// reported after every change: null when signed out or unconfigured.
export function accountFactsOf(
  config: AccountServiceConfig,
  record: StoredAccount | null,
): AccountFacts | null {
  if (record === null || !isConfigured(config)) return null;
  return {
    hubUrl: config.hubUrl,
    accountId: record.accountId,
    credential: record.credential,
    deviceKey: record.deviceKey,
    webOrigin: config.webOrigin,
    acceptsCommands: record.acceptsCommands === true,
  };
}

// A nuke's sign-out: this device revoked on the hub and its credential
// dropped. Answers why the revoke didn't land when it stays parked for
// later (offline, the hub down), since the parking goes with userData
// at the next start. Null when it landed, the hub had already let the
// device go, or there was nothing to revoke. A device signed out
// before, whose revoke is parked still, tries that one once more.
export async function nukeSignOut(device: {
  config: AccountServiceConfig;
  service: AccountService;
  store: AccountStore;
  deviceId: string;
}): Promise<string | null> {
  const signedIn = device.store.read() !== null;
  let failure = "";
  await signOutDevice({
    ...device,
    onRevokeFailure: (error) => {
      failure = errorMessageOf(error);
    },
  });
  if (!signedIn) {
    const parked = await retryParkedRevoke(device);
    if (parked.kind === "failed") failure = errorMessageOf(parked.error);
  }
  return device.store.readParked() === null ? null : failure;
}
