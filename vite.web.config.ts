// Vite config for the browsable web client (v2 step 5, slice B),
// mirroring vite.renderer.config.ts so the reused renderer tree builds
// identically: same plugins (tailwind, react with the compiler preset),
// same aliases, same build-info defines. Differences are the web root,
// the dist-web output at the repo root, a distinct dev port so the
// desktop's renderer dev server can run beside it, and the envPrefix
// entries that bake the non-secret account service config into the
// bundle (see web/account/config.ts).
import { execSync } from "node:child_process";
import { resolve } from "node:path";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { ACCOUNT_ENV_KEYS } from "./shared/account/serviceConfig";

function gitOutput(args: string): string | null {
  try {
    return execSync(`git ${args}`, { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

function buildInfo(mode: string): { version: string; commit: string } {
  const sha = gitOutput("rev-parse --short HEAD");
  const dirty =
    (gitOutput("status --porcelain -- ':(exclude,top)package.json'") ?? "") !==
    "";
  const commit = sha ? (dirty ? `${sha}-dirty` : sha) : "unknown";
  const tag = gitOutput("describe --tags --exact-match HEAD");
  const version = mode === "production" ? (tag ?? "unknown") : "dev";
  return { version, commit };
}

export default defineConfig(({ mode }) => {
  const { version, commit } = buildInfo(mode);

  return {
    root: resolve(__dirname, "web"),
    // Vite matches envPrefix entries as prefixes, so the full key names
    // from ACCOUNT_ENV_KEYS expose exactly those vars and nothing else
    // that happens to share a prefix. Every value is a public endpoint
    // or client id by design, so inlining them leaks nothing.
    envPrefix: ["VITE_", ...ACCOUNT_ENV_KEYS],
    // Env files are read from the repo root, beside the desktop's.
    envDir: __dirname,
    resolve: {
      alias: {
        "@": resolve(__dirname, "renderer"),
        "@shared": resolve(__dirname, "shared"),
      },
    },
    // Distinct from the desktop renderer's dev server so both can run.
    server: { port: 5190, strictPort: true },
    // web/public (the default under this root) carries the CSP-safe
    // external theme boot script, copied verbatim into dist-web. The
    // desktop's repo-root public/ (material icons) stays out of this
    // build because the root is web/.
    optimizeDeps: { entries: ["index.html"] },
    define: {
      __APP_VERSION__: JSON.stringify(version),
      __APP_COMMIT__: JSON.stringify(commit),
    },
    plugins: [
      tailwindcss(),
      react(),
      babel({ presets: [reactCompilerPreset()] }),
    ],
    build: {
      outDir: resolve(__dirname, "dist-web"),
      emptyOutDir: true,
      // Never inline assets as data: URIs. The deploy's CSP is strict
      // (font-src 'self', script-src 'self'), and inlined font subsets
      // would be blocked by it, so every asset ships as a real file.
      assetsInlineLimit: 0,
    },
  };
});
