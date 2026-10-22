// Dev profiles for the launchers: a further dev instance on this
// machine that is a separate device (shared/packaging/appName.mts
// explains the app side). Each profile owns one folder under
// PROFILES_DIR:
//
//   <name>/data    the profile's data dir (SHIGOMORI_DATA_DIR)
//   <name>/repos   the tester's own repos for that forest
//
// and its userData nests under the plain dev userData, where main
// puts it (devProfileUserData). The launchers set both env vars, so
// the app AND every CLI child it spawns land on the profile's data dir
// (children inherit the launcher's environment, the app itself never
// injects SHIGOMORI_DATA_DIR, see host/lib/util/paths.ts).
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  assertDevProfileName,
  CLERK_TOKEN_STORE,
  DEV_PROFILE_ENV,
  devProfileUserData,
  CLONED_LOGIN_MARKER,
} from "../../shared/packaging/appName.mts";
import { cliDataDirName } from "../../shared/packaging/cliDist.mts";
import { flavorNames } from "@shigomori/engine/flavor";

const PROFILES_DIR = join(homedir(), `${cliDataDirName("dev")}-profiles`);

export type DevProfile = {
  name: string;
  dir: string;
  dataDir: string;
  repos: string;
  userData: string;
};

export function devProfilePaths(name: string): DevProfile {
  assertDevProfileName(name);
  const dir = join(PROFILES_DIR, name);
  return {
    name,
    dir,
    dataDir: join(dir, "data"),
    repos: join(dir, "repos"),
    userData: devProfileUserData(devUserDataDir(), name),
  };
}

// Electron's userData for the plain dev instance: macOS's appData
// joined with the dev flavor's folder (main/flavor.ts).
function devUserDataDir(): string {
  return join(
    homedir(),
    "Library",
    "Application Support",
    flavorNames("dev").userDataDir,
  );
}

// The two env vars that make a launched app run as the profile.
export function devProfileEnv(profile: DevProfile): Record<string, string> {
  return {
    [DEV_PROFILE_ENV]: profile.name,
    SHIGOMORI_DATA_DIR: profile.dataDir,
  };
}

export type DevProfileArgs = {
  // --profile <name> / --profile=<name>, null when absent.
  profile: string | null;
  // --fresh: wipe the profile's folder and userData before launch.
  fresh: boolean;
  // --clone-login: copy the plain dev instance's Clerk sign-in into
  // the profile, so it boots signed in and enrolls itself.
  cloneLogin: boolean;
  // Everything else, in order, for the caller to forward or reject.
  rest: string[];
};

// A launcher's arguments when the profile's name comes first,
// `<name> [--fresh] [--clone-login]`. Throws on anything else.
export function parsePositionalDevProfile(argv: string[]): {
  profile: DevProfile;
  args: DevProfileArgs;
} {
  const [name, ...flags] = argv;
  if (name === undefined || name.startsWith("--")) {
    throw new Error("the profile's name comes first");
  }
  const args = parseDevProfileArgs(flags);
  if (args.profile !== null) throw new Error("the name is positional here");
  if (args.rest.length > 0) {
    throw new Error(`unknown arguments ${args.rest.join(" ")}`);
  }
  return { profile: devProfilePaths(name), args };
}

export function parseDevProfileArgs(argv: string[]): DevProfileArgs {
  const out: DevProfileArgs = {
    profile: null,
    fresh: false,
    cloneLogin: false,
    rest: [],
  };
  const queue = [...argv];
  for (let arg = queue.shift(); arg !== undefined; arg = queue.shift()) {
    if (arg === "--profile") {
      out.profile = queue.shift() ?? "";
    } else if (arg.startsWith("--profile=")) {
      out.profile = arg.slice("--profile=".length);
    } else if (arg === "--fresh") {
      out.fresh = true;
    } else if (arg === "--clone-login") {
      out.cloneLogin = true;
    } else {
      out.rest.push(arg);
    }
  }
  if (out.profile === "") throw new Error("--profile needs a name");
  return out;
}

function holdsCredential(accountFile: string): boolean {
  if (!existsSync(accountFile)) return false;
  try {
    const doc = JSON.parse(readFileSync(accountFile, "utf8")) as {
      signedOut?: boolean;
      parked?: unknown;
    };
    // A parked revoke (a sign-out that never reached the hub) is an
    // enrollment the hub still holds, and the wipe takes the one
    // credential that could end it.
    return doc.signedOut !== true || doc.parked !== undefined;
  } catch {
    return false;
  }
}

// Removes a tree a killed Electron may still be writing into. A wipe
// usually follows a kill, and a Chromium helper that has not noticed
// yet can write into userData while the walk is partway through it,
// which surfaces as ENOTEMPTY. Retrying rides that out.
function rmTree(target: string): void {
  rmSync(target, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
}

// Wipes the profile's folder and userData. Local only: a device the
// profile enrolled stays on the hub (and keeps its tunnel) until it is
// revoked, so revoking is the tidy way to end a profile, and this is
// the way to start over after a crash or a hard kill.
function wipeDevProfile(profile: DevProfile): void {
  // The file also holds a signed-out remainder (the device's name, a
  // parked revoke), so only a live credential means enrolled.
  if (holdsCredential(join(profile.userData, "account.json"))) {
    console.warn(
      `[dev-profile] ${profile.name} may still be enrolled on the device ` +
        "hub. Revoke it from another device's account page if it lingers.",
    );
  }
  for (const target of [profile.dir, profile.userData]) rmTree(target);
  console.log(`[dev-profile] wiped ${profile.name}`);
}

// The Clerk bridge's token store (main/electron/ClerkTokens.ts), one
// file in userData. Dev runs under Chromium's mock keychain, so the
// safeStorage ciphertext is portable between dev instances on one
// machine.
const TOKEN_STORE_FILE = `${CLERK_TOKEN_STORE}.json`;

// The plain dev instance's sign-in, or a throw naming what to do.
function devLoginSource(): string {
  const source = join(devUserDataDir(), TOKEN_STORE_FILE);
  if (!existsSync(source)) {
    throw new Error(
      `no sign-in to clone: ${source} is missing. Sign in to the plain dev ` +
        "app (`pnpm start`) first.",
    );
  }
  return source;
}

// Copies the plain dev instance's Clerk sign-in into the profile: the
// profile then boots with a live Clerk session and enrolls itself as
// a new device of the same account, no browser round trip. Both
// instances share one Clerk client afterwards, so a Clerk sign-out in
// either window ends the session for both: end a cloned profile by
// revoking its device (the account:signOut IPC, or the account page),
// never with the window's Sign out button.
function cloneDevLogin(profile: DevProfile): void {
  const source = devLoginSource();
  mkdirSync(profile.userData, { recursive: true });
  copyFileSync(source, join(profile.userData, TOKEN_STORE_FILE));
  // The app's sign-out paths read this (account status sharedSignIn):
  // a Clerk sign-out in a window holding a clone would end the session
  // for every window that holds it.
  writeFileSync(join(profile.userData, CLONED_LOGIN_MARKER), "");
  console.log(`[dev-profile] cloned the dev sign-in into ${profile.name}`);
}

// --fresh and --clone-login, in that order, for both launchers. The
// clone's precondition is checked before the wipe, so a missing
// sign-in cannot cost a working profile.
export function applyDevProfileFlags(
  profile: DevProfile,
  args: DevProfileArgs,
): void {
  if (args.cloneLogin) devLoginSource();
  if (args.fresh) wipeDevProfile(profile);
  if (args.cloneLogin) cloneDevLogin(profile);
}
