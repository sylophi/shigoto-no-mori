import { execSync } from "node:child_process";
import { resolve } from "node:path";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, loadEnv } from "vite";

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
  const env = loadEnv(mode, process.cwd(), "");
  const port = env["PORT"] ? Number(env["PORT"]) : undefined;
  const { version, commit } = buildInfo(mode);

  return {
    resolve: {
      alias: {
        "@": resolve(__dirname, "renderer"),
        "@shared": resolve(__dirname, "shared"),
      },
    },
    server: port ? { port, strictPort: true } : undefined,
    // Scope the dep scanner to the real entry; its default **/*.html
    // glob picks up LICENSES.chromium.html inside out/ packaged builds
    // and fails the scan with noisy (harmless) errors at dev boot.
    optimizeDeps: { entries: ["index.html"] },
    define: {
      __APP_VERSION__: JSON.stringify(version),
      __APP_COMMIT__: JSON.stringify(commit),
    },
    plugins: [
      tailwindcss(),
      react(),
      // @vitejs/plugin-react v6 dropped its inline babel option (it
      // switched to Oxc for Fast Refresh), so the React Compiler ships
      // via @rolldown/plugin-babel using the canonical preset exported
      // by the react plugin itself.
      babel({ presets: [reactCompilerPreset()] }),
    ],
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
