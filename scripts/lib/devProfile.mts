// Dev profiles for the launchers: a further dev instance on this
// machine that is a separate device (shared/appName.mts explains the
// app side). Each profile owns one folder under PROFILES_DIR:
//
//   <name>/data    the profile's data dir (SHIGOMORI_DATA_DIR)
//   <name>/repos   the tester's own repos for that forest
//
// and its userData nests under the plain dev userData, where main
// puts it (devProfileUserData). The launchers set both env vars, so
// the app AND every CLI child it spawns land on the profile's data dir
// (children inherit the launcher's environment, the app itself never
// injects SHIGOMORI_DATA_DIR, see host/lib/util/paths.ts).
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import {
  assertDevProfileName,
  CLERK_TOKEN_STORE,
  DEV_PROFILE_ENV,
  DEV_USER_DATA_SUFFIX,
  devProfileUserData,
} from "../../shared/appName.mts";
import {
  CLI_DIST_DIR,
  cliBinaryName,
  cliDataDirName,
} from "../../shared/cliDist.mts";
import { repoRoot } from "./checkKit.mjs";
import { productName } from "./devBundle.mts";

export const PROFILES_DIR = join(
  homedir(),
  `${cliDataDirName("dev")}-profiles`,
);

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

// Electron's userData for the plain dev instance: the platform's
// appData joined with the product name (Electron's own default) plus
// the dev suffix main/index.ts appends.
function devUserDataDir(): string {
  const home = homedir();
  const appData =
    platform() === "darwin"
      ? join(home, "Library", "Application Support")
      : platform() === "win32"
        ? (process.env.APPDATA ?? join(home, "AppData", "Roaming"))
        : (process.env.XDG_CONFIG_HOME ?? join(home, ".config"));
  return join(appData, `${productName}${DEV_USER_DATA_SUFFIX}`);
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

export function parseDevProfileArgs(argv: string[]): DevProfileArgs {
  const out: DevProfileArgs = {
    profile: null,
    fresh: false,
    cloneLogin: false,
    rest: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--profile") {
      out.profile = argv[++i] ?? "";
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

// The dev CLI the app delegates to (main/electron/cliRunner.ts finds
// it the same way), built by `pnpm start` and buildDevCli.
export function devCliPath(): string {
  const cli = join(repoRoot, CLI_DIST_DIR, cliBinaryName("dev"));
  if (!existsSync(cli)) {
    throw new Error(
      `The dev CLI is missing at ${cli}: run \`pnpm cli:build --dev\` (or ` +
        "`pnpm start` once) first.",
    );
  }
  return cli;
}

export function buildDevCli(): void {
  execFileSync("node", [join(repoRoot, "scripts", "dev-cli.mjs")], {
    cwd: repoRoot,
    stdio: "inherit",
  });
}

// Registers every repo under `dir` as a project of the profile's
// data dir, through the dev CLI so the registry is written the one way.
export function registerProjects(profile: DevProfile, dir: string): void {
  execFileSync(devCliPath(), ["projects", "add", dir, "--all", "--yes"], {
    cwd: repoRoot,
    stdio: "inherit",
    env: { ...process.env, ...devProfileEnv(profile) },
  });
}

// Wipes the profile's folder and userData. Local only: a device the
// profile enrolled stays on the hub (and keeps its tunnel) until it is
// revoked, so revoking is the tidy way to end a profile, and this is
// the way to start over after a crash or a hard kill.
export function wipeDevProfile(profile: DevProfile): void {
  if (existsSync(join(profile.userData, "account.json"))) {
    console.warn(
      `[dev-profile] ${profile.name} may still be enrolled on the device ` +
        "hub. Revoke it from another device's Devices page if it lingers.",
    );
  }
  for (const target of [profile.dir, profile.userData]) {
    rmSync(target, { recursive: true, force: true });
  }
  console.log(`[dev-profile] wiped ${profile.name}`);
}

// The Clerk bridge's token store (main/electron/clerk.ts), one file in
// userData. On macOS dev runs under Chromium's mock keychain, so the
// safeStorage ciphertext is portable between dev instances on one
// machine. On Linux and Windows the dev keychain item is per app
// name, which the profile suffix changes, so the copy decrypts to
// nothing there and the profile boots signed out.
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
// revoking its device (the account:signOut IPC, or the Devices page),
// never with the window's Sign out button.
export function cloneDevLogin(profile: DevProfile): void {
  const source = devLoginSource();
  mkdirSync(profile.userData, { recursive: true });
  copyFileSync(source, join(profile.userData, TOKEN_STORE_FILE));
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
