// Test stand-ins for the update endpoints (lab/dev-app.md), moved
// out of our environment at startup. Everything the app spawns
// inherits process.env, and a script run passes it on to package
// scripts, so an override left there would reach every script tree.
// Only the update check gets them.
const OVERRIDES = [
  "SHIGOMORI_UPDATE_FEED_URL",
  "SHIGOMORI_UPDATE_RELEASES_URL",
] as const;

const taken = new Map<string, string>();

// Called once at startup, before anything is spawned.
export function takeUpdateEndpointOverrides(): void {
  for (const name of OVERRIDES) {
    const value = process.env[name];
    delete process.env[name];
    if (value) taken.set(name, value);
  }
}

export function updateEndpoints(): {
  readonly feedUrl?: string;
  readonly releasesUrl?: string;
} {
  return {
    feedUrl: taken.get("SHIGOMORI_UPDATE_FEED_URL"),
    releasesUrl: taken.get("SHIGOMORI_UPDATE_RELEASES_URL"),
  };
}

// The overrides as `open --env` takes them, for the relaunch
// (electron/relaunch.ts), or a relaunched test build would check the
// real feeds.
export function updateEndpointOverrideEnv(): string[] {
  return [...taken].flatMap(([name, value]) => ["--env", `${name}=${value}`]);
}
