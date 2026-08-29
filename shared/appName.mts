// Single source for the dev flavor's display-name suffix. The base
// name is package.json's productName everywhere already: Electron
// derives app.name from it at runtime, forge derives the packaged
// bundle's naming from it, and the dev bundle script reads it
// directly. The suffix is the only spelling that could drift between
// its consumers (main/index.ts app.setName, and the dev bundle's
// CFBundleName/CFBundleDisplayName/CFBundleURLName in
// scripts/dev-electron.mts), and on Linux and Windows it also names
// the dev safeStorage keychain item, so a drift would silently split
// labels or re-key dev tokens with no build error.
export const DEV_NAME_SUFFIX = " (Dev)";
