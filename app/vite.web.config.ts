// Vite config for the browsable web client,
// mirroring vite.renderer.config.ts so the reused renderer tree builds
// identically: same plugins (tailwind, react with the compiler preset),
// same aliases, same build-info defines. Differences are the web root,
// the dist-web output at the app root, a distinct dev port so the
// desktop's renderer dev server can run beside it, and the envPrefix
// entries that bake the non-secret account service config into the
// bundle (see web/account/config.ts).
import { execSync } from "node:child_process";
import { cpSync, createReadStream, existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { reactCompiler } from "./vite.reactCompiler";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type HtmlTagDescriptor, type Plugin } from "vite";
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
    (gitOutput("status --porcelain -- ':(exclude,top)app/package.json'") ??
      "") !== "";
  const commit = sha ? (dirty ? `${sha}-dirty` : sha) : "unknown";
  const tag = gitOutput("describe --tags --exact-match HEAD");
  const version = mode === "production" ? (tag ?? "unknown") : "dev";
  return { version, commit };
}

// The material icons the file pickers show. scripts/copy-material-icons.mjs
// stages them in the app-root public/ (with the bare-name aliases of
// the package's .clone.svg files the manifest asks for), which this
// build's web/ root never sees, and without them every icon request
// falls through to index.html. So that directory is copied into the
// output, and served from where it is in dev. A build that finds it
// missing fails, where skipping would ship every icon broken.
function materialIcons(): Plugin {
  const source = resolve(__dirname, "public", "material-icons");
  let outDir = "";
  return {
    name: "sm-material-icons",
    configResolved(config) {
      outDir = config.build.outDir;
    },
    configureServer(server) {
      server.middlewares.use("/material-icons", (req, res, next) => {
        const [path = ""] = (req.url ?? "").split("?");
        const file = join(source, basename(path));
        if (!file.endsWith(".svg") || !existsSync(file)) {
          next();
          return;
        }
        res.setHeader("Content-Type", "image/svg+xml");
        createReadStream(file).pipe(res);
      });
    },
    closeBundle() {
      if (!existsSync(source)) {
        throw new Error(
          `no material icons at ${source}: run node scripts/copy-material-icons.mjs`,
        );
      }
      cpSync(source, join(outDir, "material-icons"), { recursive: true });
    },
  };
}

// web/main.tsx reaches the app through a dynamic import (the bridge
// must be installed first), so on its own the built page names only
// the small entry: the browser learns of the boot chunk, its imports
// and the stylesheet after downloading and running that entry, one
// round trip late. Naming them in the page starts them with it.
function preloadBoot(): Plugin {
  return {
    name: "sm-preload-boot",
    transformIndexHtml: {
      order: "post",
      handler(html, ctx) {
        const chunks = Object.values(ctx.bundle ?? {}).flatMap((file) =>
          file.type === "chunk" ? [file] : [],
        );
        const boot = chunks.find(
          (chunk) => chunk.isDynamicEntry && chunk.name === "boot",
        );
        if (boot === undefined) return [];
        // Minus what the page already names (the entry and its own
        // imports, which the boot chunk shares).
        const tags: HtmlTagDescriptor[] = [boot.fileName, ...boot.imports]
          .filter((fileName) => !html.includes(`/${fileName}"`))
          .map((fileName) => ({
            tag: "link",
            attrs: {
              rel: "modulepreload",
              crossorigin: true,
              href: `/${fileName}`,
            },
            injectTo: "head",
          }));
        for (const fileName of boot.viteMetadata?.importedCss ?? []) {
          tags.push({
            tag: "link",
            attrs: {
              rel: "stylesheet",
              crossorigin: true,
              href: `/${fileName}`,
            },
            injectTo: "head",
          });
        }
        return tags;
      },
    },
  };
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
    // Env files are read from the app root, beside the desktop's.
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
    // desktop's app-root public/ is outside this root, so its
    // material icons come in through the materialIcons plugin above.
    optimizeDeps: { entries: ["index.html"] },
    define: {
      __APP_VERSION__: JSON.stringify(version),
      __APP_COMMIT__: JSON.stringify(commit),
    },
    plugins: [
      tailwindcss(),
      react(),
      reactCompiler(),
      materialIcons(),
      preloadBoot(),
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
