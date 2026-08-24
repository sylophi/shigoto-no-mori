// The argv presence flag main appends beside the device id
// (webPreferences.additionalArguments) on unpackaged builds, so the
// preload can expose `api.isDev` synchronously. isDev is a client
// fact: dev-only affordances (theme hotkeys, the dev badge) must key
// off the build showing the window, or a packaged client talking to a
// dev host would light them up in a shipped build. Same pattern as
// deviceIdFlag.mts, and the same constraint: constant-only module, the
// preload bundle imports it.
export const DEV_BUILD_FLAG = "--sm-dev-build";
