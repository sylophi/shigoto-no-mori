/// <reference types="@electron-forge/plugin-vite/forge-vite-env" />

// oxlint-disable no-underscore-dangle -- standard Vite `define` naming convention.
// The account service values captured from the build environment and
// inlined into the main bundle by the define in vite.node.config.ts.
// Empty when none were set at build time. Referenced only from the
// electron glue (main/ipc/modules/account.ts), never from the pure
// shared modules, which must stay drivable under plain node.
declare const __SM_ACCOUNT_BAKED_ENV__: Record<string, string>;
// True when the build was packaged with APPLE_SIGNING_IDENTITY set, so
// forge signed it with a Developer ID (vite.node.config.ts). Read only
// by main/index.ts, for the macOS keychain policy.
declare const __SM_SIGNED_MAC_BUILD__: boolean;
