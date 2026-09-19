import { execSync } from "node:child_process";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { reactCompiler } from "./vite.reactCompiler";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { rendererDevServerPort } from "./scripts/lib/portsEnvFile.mts";

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
  // The release workflow stamps the tag into package.json before
  // building, because Info.plist and app.getVersion() read the version
  // from there at packaging time. Excluding that one file keeps shipped
  // builds from reporting themselves as dirty, while genuine
  // uncommitted changes still set the flag. The "top" magic anchors the
  // exclusion to the repo root, so it holds no matter which directory
  // vite is invoked from.
  const dirty =
    (gitOutput("status --porcelain -- ':(exclude,top)package.json'") ?? "") !==
    "";
  const commit = sha ? (dirty ? `${sha}-dirty` : sha) : "unknown";
  const tag = gitOutput("describe --tags --exact-match HEAD");
  const version = mode === "production" ? (tag ?? "unknown") : "dev";
  return { version, commit };
}

export default defineConfig(({ mode }) => {
  const envPort = rendererDevServerPort(__dirname);
  const port = envPort ? Number(envPort) : undefined;
  const { version, commit } = buildInfo(mode);

  return {
    resolve: {
      alias: {
        "@": resolve(__dirname, "renderer"),
        "@shared": resolve(__dirname, "shared"),
      },
    },
    // The Electron window loads over the shigomori-dev:// scheme with
    // main proxying http to this server (main/electron/clerk.ts), so
    // the HMR client cannot derive its websocket endpoint from the page
    // location, so pin it to the dev server directly. The pin is
    // unconditional: with PORT unset vite picks its own port and
    // injects the resolved one, and losing the pin with the port block
    // would leave a working page with silently dead HMR. `ws` is the
    // current spelling, `hmr.{host,port,…}` is deprecated in vite 8.
    server: {
      ...(port ? { port, strictPort: true } : {}),
      ws: { host: "localhost", protocol: "ws" },
    },
    // Scope the dep scanner to the real entry; its default **/*.html
    // glob picks up LICENSES.chromium.html inside out/ packaged builds
    // and fails the scan with noisy (harmless) errors at dev boot.
    optimizeDeps: { entries: ["index.html"] },
    define: {
      __APP_VERSION__: JSON.stringify(version),
      __APP_COMMIT__: JSON.stringify(commit),
    },
    plugins: [tailwindcss(), react(), reactCompiler()],
    build: {
      // Keep material-icon-theme SVGs as separate hashed files so each one
      // loads on-demand when its icon is actually displayed. Inlined as
      // base64 they'd bloat the JS bundle for icons that may never render.
      assetsInlineLimit: (filePath) => {
        if (filePath.includes("material-icon-theme/icons/")) return false;
        return undefined;
      },
    },
  };
});
