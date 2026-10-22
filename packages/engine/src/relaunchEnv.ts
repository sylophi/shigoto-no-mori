// What a relaunch through `open` passes on, the app's own (a data-folder
// move, a nuke, the fatal recovery) and the installer's. `open` hands
// the app our environment, but the app takes the update stand-ins and
// the debug port out of its own as it starts, so a test build's
// stand-ins and its debug port go by name, or the app would come back
// checking the real feeds, with no port to drive it on. A data dir the
// environment chose (a test run's) goes too, as this process resolved it.
export const RELAUNCH_ENV = {
  dataDir: "SHIGOMORI_DATA_DIR",
  feedUrl: "SHIGOMORI_UPDATE_FEED_URL",
  releasesUrl: "SHIGOMORI_UPDATE_RELEASES_URL",
  debugPort: "SHIGOMORI_DEBUG_PORT",
} as const;

export type Relaunched = {
  readonly [K in keyof typeof RELAUNCH_ENV]?: string | undefined;
};

// As `open --env` takes them.
export const openEnvArgs = (carried: Relaunched): string[] =>
  (Object.keys(RELAUNCH_ENV) as (keyof typeof RELAUNCH_ENV)[]).flatMap(
    (key) => {
      const value = carried[key];
      return value ? ["--env", `${RELAUNCH_ENV[key]}=${value}`] : [];
    },
  );
