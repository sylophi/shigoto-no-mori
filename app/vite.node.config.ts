// Shared by the node-side builds (main, preload and the host): the
// @shared alias, the account define, and the runtime imports Vite must
// not bundle. One file means a future node-side option can't be added
// to just one of them. The account define is only referenced by main
// (main/electron/account.ts). In preload nothing names the constant,
// so nothing is inlined there.
import { resolve } from "node:path";
import { defineConfig } from "vite";
import { ACCOUNT_ENV_KEYS } from "@shigomori/contracts/accountServiceConfig";
import { buildFlavor } from "./shared/packaging/buildFlavor.mts";
import { macSigningIdentity } from "./shared/packaging/macSigning.mts";

// The account service values (ACCOUNT_ENV_KEYS) present in the BUILD
// environment, baked into
// the bundle. A packaged .app launched from Finder or the Dock inherits
// launchd's environment, not the owner's shell, so at runtime
// process.env carries none of these. Capturing them at package time is
// how a shipped build arrives configured. Every value is public by
// design, an endpoint, Clerk's publishable key or the device grant's
// client id (packages/contracts/src/accountServiceConfig.ts), so
// inlining them leaks nothing.
// An explicit define of one named constant rather than envPrefix +
// import.meta.env: this build targets node, and import.meta.env
// substitution is fragile enough on the web side (see the warning in
// web/account/config.ts) not to bet a different target behaves the
// same, while a define is unambiguous in any target.
function bakedAccountEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ACCOUNT_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

export default defineConfig({
  resolve: {
    alias: {
      "@shared": resolve(__dirname, "shared"),
      "@host": resolve(__dirname, "host"),
    },
  },
  define: {
    __SM_ACCOUNT_BAKED_ENV__: JSON.stringify(bakedAccountEnv()),
    // The flavor a packaged build runs as (main/flavor.ts). A dev run
    // is dev whatever this says.
    __SM_PACKAGED_FLAVOR__: JSON.stringify(buildFlavor(process.env)),
    // Whether forge signs this build with a Developer ID (the same
    // reading forge.config.ts makes). main/index.ts gives only such a
    // build the real macOS keychain: an ad-hoc bundle on it is one
    // login-password prompt per read (main/core/keychain/reset.ts).
    __SM_SIGNED_MAC_BUILD__: JSON.stringify(
      macSigningIdentity(process.env) !== null,
    ),
  },
  build: {
    rollupOptions: {
      // node-pty loads its native addon and spawn helper by path
      // relative to its own package, so it has to stay a real
      // node_modules require (forge.config.ts ships that directory).
      // Every `node:` import is Electron's own. Forge marks only the
      // building Node's builtinModules external, and on Node 22 those
      // leave out `node:sqlite`, which Vite would bundle as an empty
      // stub, leaving the host's store with no SQLite.
      external: ["node-pty", /^node:/],
    },
  },
});
