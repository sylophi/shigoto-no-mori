// What every build of the renderer tree shares: the desktop window
// (vite.renderer.config.ts), the web client (vite.web.config.ts) and
// the fake host (lab/fake-host/vite.base.ts). Each merges its own on top.
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { insideTheRoot } from "@shigomori/ui/styles/insideTheRoot.ts";
import { woff2Only } from "@shigomori/ui/styles/woff2Only.ts";
import { normalizePath, type UserConfig } from "vite";
import { dedupe } from "./vite.dedupe";
import { materialIcons } from "./vite.materialIcons";
import { reactCompiler } from "./vite.reactCompiler";

const appRoot = dirname(fileURLToPath(import.meta.url));

export const rendererTreeAliases = {
  "@": resolve(appRoot, "renderer"),
  "@shared": resolve(appRoot, "shared"),
};

export function rendererTreeConfig(opts: {
  root: string;
  // The page vite pre-bundles deps from, relative to the root.
  entry: string;
}): UserConfig {
  // A glob, so with forward slashes on Windows too.
  const fromRoot = (path: string) =>
    normalizePath(relative(opts.root, resolve(appRoot, path)));
  return {
    root: opts.root,
    // The web client's public files, for the theme boot script every
    // shell's page loads. The material icons come in through their
    // plugin (vite.materialIcons.ts).
    publicDir: resolve(appRoot, "web/public"),
    resolve: { dedupe, alias: rendererTreeAliases },
    // The contracts package is served as source. Prebundled, it carries a
    // copy of effect's Schema of its own, and the renderer's Schema calls
    // fail on schemas built by that copy.
    // The ui package is source the app imports, so the scanner crawls it
    // too: a dependency only it imports (Base UI's dialog) is served raw
    // otherwise, and its CommonJS imports fail in the page. Nor does the
    // scanner enter the contracts package, an excluded one, so it
    // crawls that source too: a dependency only it imports (effect's
    // RpcMiddleware, semver) is otherwise met as the page loads, bundled
    // then, and the page reloads.
    optimizeDeps: {
      entries: [
        opts.entry,
        fromRoot("../packages/ui/src/**/*.{ts,tsx}"),
        fromRoot("../packages/contracts/src/**/*.ts"),
      ],
      exclude: ["@shigomori/contracts"],
      // Imported only by a module of the app's (HighlightWorkers.tsx),
      // which the scan doesn't reach: met as a page draws, it's bundled
      // then and the page reloads.
      include: ["@pierre/diffs/worker"],
    },
    // The package's stylesheet stops at the theme root.
    css: { postcss: { plugins: [insideTheRoot(), woff2Only()] } },
    plugins: [tailwindcss(), react(), reactCompiler(), materialIcons()],
  };
}
