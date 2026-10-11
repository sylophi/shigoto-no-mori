// The dev launchers' names for what a dev instance keeps: its profiles
// and the files main and the launchers both read in userData. The
// flavors' own names (app name, userData folder) are the flavor table's
// (packages/engine/src/flavor.ts).
//
// Like shared/packaging/cliDist.mts: node-builtin imports only, so
// plain `node scripts/*.mts` can load it without a loader shim, and
// never imported from the renderer.
import { join } from "node:path";

// The Clerk bridge's token store in userData, minus the .json the SDK
// appends (main/electron/clerk.ts names it, the dev launchers copy it
// between instances to clone a sign-in).
export const CLERK_TOKEN_STORE = "clerk-tokens";

// Dev profiles: a second, third, ... dev instance on one machine, each
// a separate device (its own userData, so its own single-instance
// lock, hub credential and Clerk tokens). Dev only. The env
// var names the profile. The launcher that sets it also sets
// SHIGOMORI_DATA_DIR to the profile's own data dir, and main refuses a
// profile without one: two devices over the same forest would be a
// lie the hub cannot see through. The profile's userData nests under
// the plain dev userData so Application Support stays one folder per
// flavor.
export const DEV_PROFILE_ENV = "SHIGOMORI_PROFILE";

// Written into a dev profile's userData beside its Clerk token store
// when --clone-login copied the plain dev app's sign-in there. The
// clone is persistent state, so the fact that this window's Clerk
// session is shared with other windows has to be too: main reads it
// on every account status (sharedSignIn), whatever flags a later
// launch passed.
export const CLONED_LOGIN_MARKER = "clerk-tokens.cloned";

// Under `pnpm dev` the launcher (scripts/dev-electron.mts) names a
// marker file here. The app touches it before quitting when it wants
// to be started again (main/electron/relaunch.ts), and the launcher
// restarts forge instead of the app respawning a detached Electron.
export const DEV_RELAUNCH_FILE_ENV = "SHIGOMORI_DEV_RELAUNCH_FILE";

const DEV_PROFILE_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

// A profile name is a path component and a device-name suffix, so a
// typo fails here instead of minting a device in a folder named "..".
export function assertDevProfileName(name: string): void {
  if (!DEV_PROFILE_NAME.test(name)) {
    throw new Error(
      `${JSON.stringify(name)} is not a profile name (lowercase letters, ` +
        "digits and dashes, up to 32 characters).",
    );
  }
}

// The profile named in an environment, or null when unset or empty.
export function devProfileFromEnv(
  env: Record<string, string | undefined>,
): string | null {
  const raw = env[DEV_PROFILE_ENV]?.trim() ?? "";
  if (raw === "") return null;
  assertDevProfileName(raw);
  return raw;
}

// The folder in the plain dev userData that holds the profiles'.
export const DEV_PROFILES_DIR = "profiles";

// Where a profile's userData lives, under the plain dev userData.
export function devProfileUserData(
  devUserData: string,
  profile: string,
): string {
  return join(devUserData, DEV_PROFILES_DIR, profile);
}

// What a profile adds to the app name (menu bar label, safeStorage
// item) and to the default device name, so two profiles enrolled from
// one machine are telling apart on the account page. One spelling for
// both consumers (main/electron/devProfile.ts).
export function devProfileNameSuffix(profile: string): string {
  return ` [${profile}]`;
}
