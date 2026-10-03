import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { defineConfig } from "astro/config";

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
  vite: {
    // Keep every asset and script a real file. Inlined data: URLs and
    // inline scripts would each need their own CSP exception, and files
    // cache on their own.
    build: { assetsInlineLimit: 0 },
  },
});
