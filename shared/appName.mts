// Single source for the dev flavor's display-name suffix. The base
// name is package.json's productName everywhere already: Electron
// derives app.name from it at runtime, forge derives the packaged
// bundle's naming from it, and the dev bundle script reads it
// directly. The suffix is the only spelling that could drift between
// its consumers (main/index.ts app.setName, and the dev bundle's
// CFBundleName/CFBundleDisplayName/CFBundleURLName in
// scripts/lib/devBundle.mts), and on Linux and Windows it also names
// the dev safeStorage keychain item, so a drift would silently split
// labels or re-key dev tokens with no build error.
//
// Like shared/cliDist.mts: node-builtin imports only, so plain `node
// scripts/*.mts` can load it without a loader shim, and never imported
// from the renderer.
import { join } from "node:path";

export const DEV_NAME_SUFFIX = " (Dev)";

// The dev flavor's userData suffix (main/index.ts), spelled here so
// the dev launchers (scripts/lib/devProfile.mts) can find the folder
// a profile's data lives in without a running app.
export const DEV_USER_DATA_SUFFIX = " (dev)";

// The Clerk bridge's token store in userData, minus the .json the SDK
// appends (main/electron/clerk.ts names it, the dev launchers copy it
// between instances to clone a sign-in).
export const CLERK_TOKEN_STORE = "clerk-tokens";

// Dev profiles: a second, third, ... dev instance on one machine, each
// a separate device (its own userData, so its own single-instance
// lock, hub credential, grants and Clerk tokens). Dev only. The env
// var names the profile. The launcher that sets it also sets
// SHIGOMORI_ROOT to the profile's own state root, and main refuses a
// profile without one: two devices over the same forest would be a
// lie the hub cannot see through. The profile's userData nests under
// the plain dev userData so Application Support stays one folder per
// flavor.
export const DEV_PROFILE_ENV = "SHIGOMORI_PROFILE";

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

// Where a profile's userData lives, under the plain dev userData.
export function devProfileUserData(
  devUserData: string,
  profile: string,
): string {
  return join(devUserData, "profiles", profile);
}

// What a profile adds to the app name (menu bar label, safeStorage
// item) and to the default device name, so two profiles enrolled from
// one machine are telling apart on the Devices page. One spelling for
// both consumers (main/electron/devProfile.ts).
export function devProfileNameSuffix(profile: string): string {
  return ` [${profile}]`;
}
