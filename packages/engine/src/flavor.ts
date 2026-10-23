// The builds and every name that tells them apart, so two of them run
// side by side on one machine without one reading or writing another's
// files: prod is what ships, dev is what `pnpm dev` runs, and a test
// flavor is a build packaged under a word of its own (`SM_FLAVOR=lab
// pnpm package`) to try something out in isolation and throw away. A
// packaged build's flavor is baked in when it is built (the release
// workflow builds prod), and a dev run is always dev. The names are
// on-disk formats, frozen like the files they name. No imports, so
// plain `node` loads it in the build scripts.
//
// What follows from the table rather than sitting in it: the userData
// folder holds the single-instance lock, the Clerk tokens and the hub
// credential; the logs are ~/Library/Logs/<appName>; the keychain item
// safeStorage keeps its key in is "<appName> Safe Storage"; the
// file-sync daemon's state is <dataDir>/file-sync; a managed root on a
// project's own drive is /Volumes/<drive>/<dataDir>/wt.
// A test flavor is its word (testFlavorWord).
export type Flavor = "prod" | "dev" | (string & {});

export type FlavorNames = {
  // What the OS shows: the bundle's name, the dock and the menu bar.
  readonly appName: string;
  // Under ~/Library/Application Support.
  readonly userDataDir: string;
  // A dev run's bundle adds the worktree to it, so each checkout owns
  // the scheme in turn (app/scripts/lib/devBundle.mts).
  readonly bundleId: string;
  // The deep links and the renderer's origin, `<scheme>://app`.
  readonly scheme: string;
  // The data dir under the home directory.
  readonly dataDir: string;
  // The pre-2.0 data dir, adopted in place while it still holds state.
  readonly legacyDataDir: string | null;
  // Under XDG_CONFIG_HOME, where the data dir's pointer file lives.
  readonly configDir: string;
  readonly pointer: string;
  // The pointer's pre-2.0 file name, read only when `pointer` is absent.
  readonly legacyPointer: string | null;
  // The terminal command, and the spelled-out one linked beside it,
  // which the shell hook's markers and fish drop-in are named for.
  readonly binaryName: string;
  readonly alias: string;
  // Whether the updater offers this build the app's releases.
  readonly updates: boolean;
  // Whether a packaged build takes Chromium's remote debugging, so the
  // lab drives it as it drives the dev app. A test flavor's alone: one
  // is never signed with the Developer ID (forge.config.ts refuses),
  // which keeps a debugger off a signature's keychain access.
  readonly debuggable: boolean;
};

export const FLAVORS: Readonly<Record<"prod" | "dev", FlavorNames>> = {
  prod: {
    appName: "Shigoto no Mori",
    userDataDir: "Shigoto no Mori",
    bundleId: "com.sylophi.shigomori",
    scheme: "shigomori",
    dataDir: ".sm",
    legacyDataDir: "shigomori",
    configDir: "shigomori",
    pointer: "data-dir",
    legacyPointer: "root",
    binaryName: "sm",
    alias: "shigomori",
    updates: true,
    debuggable: false,
  },
  dev: {
    appName: "Shigoto no Mori (Dev)",
    userDataDir: "Shigoto no Mori (dev)",
    bundleId: "com.sylophi.shigomori.dev",
    scheme: "shigomori-dev",
    dataDir: ".smd",
    legacyDataDir: null,
    configDir: "shigomori-dev",
    pointer: "data-dir",
    legacyPointer: null,
    binaryName: "smd",
    alias: "shigomori-dev",
    updates: false,
    debuggable: false,
  },
};

// A test flavor's names, from its word.
const derive = (word: string): FlavorNames => ({
  appName: `Shigoto no Mori (${word})`,
  userDataDir: `Shigoto no Mori (${word})`,
  bundleId: `com.sylophi.shigomori.${word}`,
  scheme: `shigomori-${word}`,
  dataDir: `.sm${word}`,
  legacyDataDir: null,
  configDir: `shigomori-${word}`,
  pointer: "data-dir",
  legacyPointer: null,
  binaryName: `sm${word}`,
  alias: `shigomori-${word}`,
  updates: false,
  debuggable: true,
});

const OWN_NAMES = [
  "appName",
  "userDataDir",
  "bundleId",
  "scheme",
  "dataDir",
  "configDir",
  "binaryName",
  "alias",
] as const;

// A word a test flavor can be: lowercase letters and digits, a letter
// first, not prod or dev, and no name of theirs between its derived
// ones (`d` would be dev's `.smd`).
export const isTestFlavor = (word: string) =>
  /^[a-z][a-z0-9]{0,11}$/.test(word) &&
  !(word in FLAVORS) &&
  Object.values(FLAVORS).every((row) =>
    OWN_NAMES.every(
      (key) => derive(word)[key].toLowerCase() !== row[key].toLowerCase(),
    ),
  );

const isBuild = (text: string): text is keyof typeof FLAVORS =>
  text === "prod" || text === "dev";

export const flavorNames = (flavor: Flavor): FlavorNames =>
  isBuild(flavor) ? FLAVORS[flavor] : derive(flavor);

export const isFlavor = (text: string): text is Flavor =>
  isBuild(text) || isTestFlavor(text);

// The app's repo on GitHub, which every flavor's releases are published
// to (forge.config.ts) and read from: the update feeds, the changelog
// and the guide's source link.
export const APP_REPO_OWNER = "sylophi";
export const APP_REPO_NAME = "shigoto-no-mori";
export const APP_REPO = `${APP_REPO_OWNER}/${APP_REPO_NAME}`;
