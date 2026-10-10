import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@astrojs/react";
import tailwindcss from "@tailwindcss/vite";
import { insideTheRoot } from "@shigomori/ui/styles/insideTheRoot.ts";
import { defineConfig } from "astro/config";
import type { Plugin } from "vite";
import {
  fixtureAliases,
  fixtureDefine,
} from "shigoto-no-mori/lab/fake-host/vite.base.ts";
import { dedupe } from "shigoto-no-mori/vite.dedupe.ts";
import { reactCompiler } from "shigoto-no-mori/vite.reactCompiler.ts";

const app = resolve(dirname(fileURLToPath(import.meta.url)), "../app");

// The modules the app shares with the ui package (React, Base UI,
// effect, ...) resolve once, from the app, as in every build of the
// renderer tree (app/vite.dedupe.ts). Vite's own dedupe resolves from
// this package instead, which holds none of them but React.
function resolveSharedFromApp(): Plugin {
  const shared = new Set([...dedupe, "react", "react-dom"]);
  const from = resolve(app, "package.json");
  return {
    name: "resolve-shared-from-app",
    enforce: "pre",
    resolveId(id, importer, options) {
      const name = id.startsWith("@")
        ? id.split("/", 2).join("/")
        : id.split("/", 1)[0];
      if (name === undefined || !shared.has(name) || importer === from) {
        return null;
      }
      return this.resolve(id, from, { ...options, skipSelf: true });
    },
  };
}

export default defineConfig({
  site: "https://shigomori.com",
  devToolbar: { enabled: false },
  // Astro's default ("jsx") follows React's whitespace rules, which join
  // "like\n<code>" into "like<code>". Plain collapsing keeps the space.
  compressHTML: true,
  // The frames draw the app's views at build time (src/frames).
  integrations: [react()],
  vite: {
    // Keep every asset and script a real file. Inlined data: URLs and
    // inline scripts would each need their own CSP exception, and files
    // cache on their own.
    build: { assetsInlineLimit: 0 },
    resolve: { alias: fixtureAliases },
    define: fixtureDefine,
    // The app's stylesheet stops at the frames' roots.
    css: { postcss: { plugins: [insideTheRoot()] } },
    // Bundled into the build-time render rather than loaded from
    // node_modules at its run, so they resolve through the plugin above
    // to the app's one copy.
    ssr: { noExternal: true },
    plugins: [resolveSharedFromApp(), tailwindcss(), reactCompiler()],
  },
});
