// The three builds and every name that tells them apart, so two of
// them run side by side on one machine without one reading or writing
// another's files: prod is what ships, test is a `-test.N` prerelease
// dogfooded beside prod, and dev is what `pnpm dev` runs. A packaged
// build's flavor is baked in when it is built (the release workflow
// builds test for a test tag and prod for anything else), and a dev run
// is always dev. The names are on-disk formats, frozen like the files
// they name. No imports, so plain `node` loads it in the build scripts.
//
// What follows from the table rather than sitting in it: the userData
// folder holds the single-instance lock, the Clerk tokens and the hub
// credential; the logs are ~/Library/Logs/<appName>; the keychain item
// safeStorage keeps its key in is "<appName> Safe Storage"; the
// file-sync daemon's state is <dataDir>/file-sync; a managed root on a
// project's own drive is /Volumes/<drive>/<dataDir>/wt.
export type Flavor = "prod" | "test" | "dev";

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
  // Which releases the updater offers: full releases and the build's
  // own prerelease line (an rc), the test prereleases alone, or none.
  readonly updates: "releases" | "test" | null;
};

export const FLAVORS: Readonly<Record<Flavor, FlavorNames>> = {
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
    updates: "releases",
  },
  test: {
    appName: "Shigoto no Mori (Test)",
    userDataDir: "Shigoto no Mori (Test)",
    bundleId: "com.sylophi.shigomori.test",
    scheme: "shigomori-test",
    dataDir: ".smt",
    legacyDataDir: null,
    configDir: "shigomori-test",
    pointer: "data-dir",
    legacyPointer: null,
    binaryName: "smt",
    alias: "shigomori-test",
    updates: "test",
  },
  dev: {
    appName: "Shigoto no Mori (Dev)",
    userDataDir: "Shigoto no Mori (dev)",
    bundleId: "com.sylophi.shigomori.dev",
    scheme: "shigomori-dev",
    dataDir: ".smd",
    legacyDataDir: "shigomori-dev",
    configDir: "shigomori-dev",
    pointer: "data-dir",
    legacyPointer: "root",
    binaryName: "smd",
    alias: "shigomori-dev",
    updates: null,
  },
};

export const flavorNames = (flavor: Flavor): FlavorNames => FLAVORS[flavor];

export const isFlavor = (text: string): text is Flavor =>
  text === "prod" || text === "test" || text === "dev";

// A release tag's flavor: a `-test.N` prerelease builds test, anything
// else prod.
export const flavorOfVersion = (version: string): "prod" | "test" =>
  /^v?\d+\.\d+\.\d+-test(\.|$)/.test(version) ? "test" : "prod";
