// Test stand-ins for the update endpoints (lab/dev-app.md), moved
// out of our environment at startup. Everything the app spawns
// inherits process.env, and a script run passes it on to package
// scripts, so an override left there would reach every script tree.
// Only the update check and the relaunch get them.
import { RELAUNCH_ENV } from "@shigomori/engine/relaunchEnv";

const OVERRIDES = [RELAUNCH_ENV.feedUrl, RELAUNCH_ENV.releasesUrl] as const;

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
    feedUrl: taken.get(RELAUNCH_ENV.feedUrl),
    releasesUrl: taken.get(RELAUNCH_ENV.releasesUrl),
  };
}
