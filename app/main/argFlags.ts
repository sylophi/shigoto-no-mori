// The argv flags main uses to hand facts to the sandboxed preload
// (webPreferences.additionalArguments), and the preload's readers for
// them. One module imported by both sides (electron/windows.ts appends,
// preload.ts reads) so they can't disagree on a spelling. The preload
// bundle imports this, so it stays free of imports.

// This build's app version. The renderer needs its own version
// synchronously: it rides in the link's hello and is compared
// against a remote host's welcome to flag a version skew.
export const APP_VERSION_FLAG = "--sm-app-version=";

// The resolved Clerk publishable key, so the renderer can decide
// synchronously whether to mount the ClerkProvider. Empty value means
// the build is unconfigured.
export const CLERK_PK_FLAG = "--sm-clerk-publishable-key=";

// The page the window opens on (main/electron/windows.ts), which the
// renderer's memory history starts at.
export const ROUTE_FLAG = "--sm-route=";

// A presence flag, appended on unpackaged builds so the preload can
// expose `api.isDev` synchronously. isDev is a client fact: dev-only
// affordances (theme hotkeys, the dev badge) must key off the build
// showing the window, or a packaged client talking to a dev host would
// light them up in a shipped build.
export const DEV_BUILD_FLAG = "--sm-dev-build";

// A presence flag, passed on to each window when the app itself was
// started with it: the window then hands the lab's tools its api
// (renderer/lib/runtime/labHandle.ts), as a dev build's always does,
// and the app relaunches on SIGUSR2 (lab/relaunch.mts, main/index.ts).
export const LAB_FLAG = "--sm-lab";

// Reads a required value flag off process.argv in the preload. A
// missing or empty value means main and preload disagree on the flag,
// so fail loudly rather than run on an empty value.
export function requireArgFlag(flag: string): string {
  const value = optionalArgFlag(flag);
  if (!value) {
    throw new Error(`preload started without ${flag.slice(0, -1)}`);
  }
  return value;
}

// Reads an optional value flag off process.argv in the preload. Main
// always appends the flag, and an empty value is a legal "not
// configured" answer rather than a wiring error, so no throw.
export function optionalArgFlag(flag: string): string {
  const arg = process.argv.find((entry) => entry.startsWith(flag));
  return arg?.slice(flag.length) ?? "";
}
