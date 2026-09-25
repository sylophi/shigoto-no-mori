// The argv flags main uses to hand facts to the sandboxed preload
// (webPreferences.additionalArguments), and the preload's readers for
// them. One module imported by both sides (main/index.ts appends,
// main/preload.ts reads) so they can't disagree on a spelling. The
// preload bundle imports this, so it stays free of imports.

// The device id.
export const DEVICE_ID_FLAG = "--sm-device-id=";

// This build's app version. The renderer needs its own version
// synchronously: it rides in the socket hello frame and is compared
// against a remote host's welcome to flag a version skew.
export const APP_VERSION_FLAG = "--sm-app-version=";

// The resolved Clerk publishable key, so the renderer can decide
// synchronously whether to mount the ClerkProvider. Empty value means
// the build is unconfigured.
export const CLERK_PK_FLAG = "--sm-clerk-publishable-key=";

// A presence flag, appended on unpackaged builds so the preload can
// expose `api.isDev` synchronously. isDev is a client fact: dev-only
// affordances (theme hotkeys, the dev badge) must key off the build
// showing the window, or a packaged client talking to a dev host would
// light them up in a shipped build.
export const DEV_BUILD_FLAG = "--sm-dev-build";

// Reads a required value flag off process.argv in the preload. The
// device id and app version must each be present: a missing or empty
// value means main and preload disagree on the flag, so fail loudly
// rather than run with keys scoped to nothing or an empty version on
// the wire. `flag` is the constant with its trailing "=", `name` is the
// human-facing flag name for the error.
export function requireArgFlag(flag: string, name: string): string {
  const value = optionalArgFlag(flag);
  if (!value) {
    throw new Error(`preload started without ${name}`);
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
