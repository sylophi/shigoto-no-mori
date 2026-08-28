// Shared by both node-side builds (main and preload): they need the
// same @shared alias, and one file means a future node-side option
// can't be added to just one of them. The account define below is only
// referenced by main (main/ipc/modules/account.ts); in preload nothing
// names the constant, so nothing is inlined there.
import { resolve } from "node:path";
import { defineConfig } from "vite";

// The SM_ACCOUNT_* values present in the BUILD environment, baked into
// the bundle. A packaged .app launched from Finder or the Dock inherits
// launchd's environment, not the owner's shell, so at runtime
// process.env carries none of these; capturing them at package time is
// how a shipped build arrives configured. Every value is a public
// endpoint or a public OAuth client_id by design
// (shared/account/serviceConfig.ts), so inlining them leaks nothing.
// An explicit define of one named constant rather than envPrefix +
// import.meta.env: this build targets node, and import.meta.env
// substitution is fragile enough on the web side (see the warning in
// web/account/config.ts) not to bet a different target behaves the
// same, while a define is unambiguous in any target.
function bakedAccountEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("SM_ACCOUNT_") && value !== undefined) {
      out[key] = value;
    }
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
  },
});
