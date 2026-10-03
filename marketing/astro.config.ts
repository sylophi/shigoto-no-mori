import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import react from "@astrojs/react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";
import { shadowAppCss } from "./plugins/shadowAppCss";

// The app, whose views the page renders (components/AppSurface.astro).
const app = (path: string) =>
  fileURLToPath(new URL(`../app/${path}`, import.meta.url));

// This worktree's dev server port, which port-pool writes into
// .env.ports (the repo's port-pool.config.json) so the sites of
// different worktrees run side by side. A real MARKETING_PORT env var
// wins. Without either, Astro's default.
function devPort(): number | undefined {
  let port = process.env["MARKETING_PORT"];
  if (!port) {
    try {
      port = parseEnv(
        readFileSync(new URL(".env.ports", import.meta.url), "utf8"),
      )["MARKETING_PORT"];
    } catch {
      // Not provisioned here.
    }
  }
  return port ? Number(port) : undefined;
}

export default defineConfig({
  site: "https://shigomori.com",
  devToolbar: { enabled: false },
  server: { port: devPort() },
  // Astro's default ("jsx") follows React's whitespace rules, which join
  // "like\n<code>" into "like<code>". Plain collapsing keeps the space.
  compressHTML: true,
  // The app's views are React. With no client directive Astro renders
  // them to HTML at build time and ships none of their code.
  integrations: [react()],
  vite: {
    // Keep every asset and script a real file. Inlined data: URLs and
    // inline scripts would each need their own CSP exception, and files
    // cache on their own.
    build: { assetsInlineLimit: 0 },
    plugins: [tailwindcss(), shadowAppCss()],
    resolve: {
      // The app's own import aliases, so its views resolve here as they
      // do in its build.
      alias: {
        "@/": app("renderer/"),
        "@shared/": app("shared/"),
      },
      // One React for the page and the app's views, which would
      // otherwise reach the app's own copy from where they live.
      dedupe: ["react", "react-dom"],
    },
    // What the app's build defines, for the views that read them.
    define: {
      __APP_VERSION__: JSON.stringify("2.0.3"),
      __APP_COMMIT__: JSON.stringify("marketing"),
    },
    server: { fs: { allow: [".", app("")] } },
  },
});
