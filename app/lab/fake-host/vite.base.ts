// Everything the two fake host flavors share (vite.config.ts for the
// desktop renderer tree, vite.web.config.ts for the web shell),
// parameterized by the two things that actually differ, and the pieces
// the marketing site's build takes too. Its own module rather than
// named exports beside a default one, which vite's config bundler
// warns about.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { reactCompiler } from "../../vite.reactCompiler";
import { dedupe } from "../../vite.dedupe";
import tailwindcss from "@tailwindcss/vite";
import { insideTheRoot } from "@shigomori/ui/styles/insideTheRoot.ts";
import type { UserConfig } from "vite";
import { fixedDevServerPort } from "../../scripts/lib/portsEnvFile.mts";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, "..", "..");

// What any build of the renderer tree over the fixtures needs, the fake
// host's and the marketing site's live frames (frames.tsx): the app's
// aliases, Clerk's two flavors on the in-memory stub so the account UI
// renders signed in without a network, and the build info.
export const fixtureAliases = {
  "@clerk/electron/react": resolve(here, "clerkStub.tsx"),
  "@clerk/react": resolve(here, "clerkStub.tsx"),
  "@": resolve(appRoot, "renderer"),
  "@shared": resolve(appRoot, "shared"),
};

export const fixtureDefine = {
  __APP_VERSION__: JSON.stringify("2.0.3"),
  __APP_COMMIT__: JSON.stringify("fake-host"),
};

export function fakeHostBaseConfig(opts: {
  // Its port's key in .env.ports, so each worktree gets its own.
  portKey: "FAKE_HOST_PORT" | "FAKE_HOST_WEB_PORT";
  // The HTML entry vite pre-bundles deps from: the desktop fake host's
  // index.html, the web shell's web.html.
  entry: string;
}): UserConfig {
  return {
    root: here,
    // Reuse the web client's public dir for the CSP-safe theme boot
    // script the HTML shell references.
    publicDir: resolve(appRoot, "web/public"),
    resolve: {
      dedupe,
      alias: fixtureAliases,
    },
    server: {
      port: fixedDevServerPort(opts.portKey),
      strictPort: true,
    },
    // The contracts package is served as source. Prebundled, it carries a
    // copy of effect's Schema of its own, and the renderer's Schema calls
    // fail on schemas built by that copy.
    // The ui package is source the app imports, so the scanner crawls it
    // too: a dependency only it imports (Base UI's dialog) is served raw
    // otherwise, and its CommonJS imports fail in the page.
    optimizeDeps: {
      entries: [opts.entry, "../../../packages/ui/src/**/*.{ts,tsx}"],
      exclude: ["@shigomori/contracts"],
    },
    define: fixtureDefine,
    // The package's stylesheet stops at the theme root.
    css: { postcss: { plugins: [insideTheRoot()] } },
    plugins: [tailwindcss(), react(), reactCompiler()],
  };
}
