// Everything the two fake host flavors share (vite.config.ts for the
// desktop renderer tree, vite.web.config.ts for the web shell),
// parameterized by the two things that actually differ. Its own module
// rather than a named export beside a default one, which vite's config
// bundler warns about.
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { reactCompiler } from "../../vite.reactCompiler";
import { dedupe } from "../../vite.dedupe";
import tailwindcss from "@tailwindcss/vite";
import type { UserConfig } from "vite";
import { fixedDevServerPort } from "../../scripts/lib/portsEnvFile.mts";

const appRoot = resolve(__dirname, "..", "..");

export function fakeHostBaseConfig(opts: {
  // Its port's key in .env.ports, so each worktree gets its own.
  portKey: "FAKE_HOST_PORT" | "FAKE_HOST_WEB_PORT";
  // The HTML entry vite pre-bundles deps from: the desktop fake host's
  // index.html, the web shell's web.html.
  entry: string;
}): UserConfig {
  return {
    root: __dirname,
    // Reuse the web client's public dir for the CSP-safe theme boot
    // script the HTML shell references.
    publicDir: resolve(appRoot, "web/public"),
    resolve: {
      dedupe,
      alias: {
        "@clerk/electron/react": resolve(__dirname, "clerkStub.tsx"),
        "@clerk/react": resolve(__dirname, "clerkStub.tsx"),
        "@": resolve(appRoot, "renderer"),
        "@shared": resolve(appRoot, "shared"),
      },
    },
    server: {
      port: fixedDevServerPort(opts.portKey),
      strictPort: true,
    },
    // The contracts package is served as source. Prebundled, it carries a
    // copy of effect's Schema of its own, and the renderer's Schema calls
    // fail on schemas built by that copy.
    optimizeDeps: {
      entries: [opts.entry],
      exclude: ["@shigomori/contracts"],
    },
    define: {
      __APP_VERSION__: JSON.stringify("2.0.3"),
      __APP_COMMIT__: JSON.stringify("fake-host"),
    },
    plugins: [tailwindcss(), react(), reactCompiler()],
  };
}
