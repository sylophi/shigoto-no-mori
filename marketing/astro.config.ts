import { cpSync, createReadStream, existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@astrojs/react";
import tailwindcss from "@tailwindcss/vite";
import { insideTheRoot } from "@shigomori/ui/styles/insideTheRoot.ts";
import type { AstroIntegration } from "astro";
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

// The stylesheets the app's boot loads for itself, which the page already
// has: the app's (the page links it, for the frames drawn at build time)
// and Zen Maru Gothic's (the page has its own faces, and the rest falls
// back to Hiragino Maru Gothic as the page's text does). Astro links
// every stylesheet in a script's graph into the head, a lazy import's
// too, so left in they would hold up the first paint.
function pageHasAppStylesheets(): Plugin {
  const boot = resolve(app, "renderer/boot.tsx");
  const empty = "\0page-has-it";
  return {
    name: "page-has-app-stylesheets",
    enforce: "pre",
    resolveId(id, importer) {
      if (importer !== boot) return null;
      return id === "./app.css" || id === "@shigomori/ui/styles/fonts.css"
        ? empty
        : null;
    },
    load(id) {
      return id === empty ? "" : null;
    },
  };
}

// The file icons the live frames' file lists draw, from the URL the
// app asks for them at (/material-icons/<name>.svg, @shigomori/ui's
// materialIcons.ts): served in dev, copied into the build. A file each,
// fetched only when a frame shows it.
function materialIcons(): AstroIntegration {
  const icons = resolve(
    app,
    "../packages/ui/node_modules/material-icon-theme/icons",
  );
  return {
    name: "material-icons",
    hooks: {
      "astro:server:setup": ({ server }) => {
        server.middlewares.use("/material-icons", (req, res, next) => {
          const file = join(
            icons,
            basename((req.url ?? "").split("?")[0] ?? ""),
          );
          if (!file.endsWith(".svg") || !existsSync(file)) return next();
          res.setHeader("Content-Type", "image/svg+xml");
          createReadStream(file).pipe(res);
        });
      },
      "astro:build:done": ({ dir }) => {
        cpSync(icons, join(fileURLToPath(dir), "material-icons"), {
          recursive: true,
        });
      },
    },
  };
}

export default defineConfig({
  site: "https://shigomori.com",
  devToolbar: { enabled: false },
  // Astro's default ("jsx") follows React's whitespace rules, which join
  // "like\n<code>" into "like<code>". Plain collapsing keeps the space.
  compressHTML: true,
  // The frames draw the app's views at build time (src/frames). The page
  // has no island for Fast Refresh to hook into in dev, so the app's
  // modules go without it.
  integrations: [react({ exclude: /\/(app|packages)\// }), materialIcons()],
  vite: {
    // Keep every asset and script a real file. Inlined data: URLs and
    // inline scripts would each need their own CSP exception, and files
    // cache on their own.
    build: { assetsInlineLimit: 0 },
    resolve: { alias: fixtureAliases },
    define: fixtureDefine,
    // The app's stylesheet stops at the frames' roots.
    css: { postcss: { plugins: [insideTheRoot()] } },

    plugins: [
      resolveSharedFromApp(),
      pageHasAppStylesheets(),
      tailwindcss(),
      reactCompiler(),
    ],
  },
});
