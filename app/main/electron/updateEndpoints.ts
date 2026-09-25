// Test stand-ins for the update endpoints (MANUAL-TESTING.md), moved
// out of our environment at startup. Everything the app spawns
// inherits process.env, and `sm run` passes it on to package scripts,
// so an override left there would reach every script tree. Only the
// update check gets them, as flags to its own CLI child.
const OVERRIDES = [
  ["SHIGOMORI_UPDATE_FEED_URL", "--feed-url"],
  ["SHIGOMORI_UPDATE_RELEASES_URL", "--releases-url"],
] as const;

const taken = new Map<string, string>();

// Called once at startup, before anything is spawned.
export function takeUpdateEndpointOverrides(): void {
  for (const [name] of OVERRIDES) {
    const value = process.env[name];
    delete process.env[name];
    if (value) taken.set(name, value);
  }
}

export function updateEndpointFlags(): string[] {
  return OVERRIDES.flatMap(([name, flag]) => {
    const value = taken.get(name);
    return value === undefined ? [] : [`${flag}=${value}`];
  });
}

// app.relaunch() starts the new process with our environment, so the
// overrides go back in just before it, or a relaunched test build
// would check the real feeds.
export function restoreUpdateEndpointOverrides(): void {
  for (const [name, value] of taken) process.env[name] = value;
}
