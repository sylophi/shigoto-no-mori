// What the two shells a host runs under share of the account: the
// desktop's main (main/electron/account.ts) and the headless host's
// (headless/account.ts), with the host itself: the service's config,
// and a nuke's sign-out.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";
import {
  mergeServiceEnv,
  resolveServiceConfig,
  type AccountServiceConfig,
} from "@shigomori/contracts/accountServiceConfig";
import type { DevicePort } from "./handlers";

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

// A nuke's sign-out, which also delivers a removal an earlier sign-out
// owes. Answers why the service may still list this device, since the
// nuke takes with it what would tell the service later. Null when it
// let the device go.
export async function nukeSignOut(device: DevicePort): Promise<string | null> {
  return (await device.signOut())
    ? null
    : "The account service couldn't be told this device signed out.";
}
