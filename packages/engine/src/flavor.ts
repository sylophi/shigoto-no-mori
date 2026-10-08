// The two builds: prod ships with the app and touches real state, dev
// is what `pnpm dev` links and touches only dev state. The names are
// on-disk formats, frozen like the files they name.
export type Flavor = "prod" | "dev";

export const flavorNames = (flavor: Flavor) =>
  flavor === "prod"
    ? {
        binaryName: "sm",
        // What the shell hook's markers and fish drop-in are named for.
        alias: "shigomori",
        dataDir: ".sm",
        legacyDataDir: "shigomori",
        configDir: "shigomori",
        pointer: "data-dir",
        legacyPointer: "root",
      }
    : {
        binaryName: "smd",
        alias: "shigomori-dev",
        dataDir: ".smd",
        legacyDataDir: "shigomori-dev",
        configDir: "shigomori-dev",
        pointer: "data-dir",
        legacyPointer: "root",
      };
