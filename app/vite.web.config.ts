// Vite config for the browsable web client, on the renderer tree's
// shared base (vite.rendererTree.ts). Its own are the web root, the
// dist-web output at the app root, a distinct dev port so the desktop's
// renderer dev server can run beside it, and the envPrefix entries that
// bake the non-secret account service config into the bundle (see
// web/account/config.ts).
import { resolve } from "node:path";
import {
  defineConfig,
  mergeConfig,
  type HtmlTagDescriptor,
  type Plugin,
} from "vite";
import { buildInfoDefine } from "./vite.buildInfo";
import { reactGrabBuild } from "./vite.reactGrab";
import { rendererTreeConfig } from "./vite.rendererTree";
import { ACCOUNT_ENV_KEYS } from "@shigomori/contracts/accountServiceConfig";
import { fixedDevServerPort } from "./scripts/lib/portsEnvFile.mts";

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
  return mergeConfig(
    rendererTreeConfig({
      root: resolve(__dirname, "web"),
      entry: "index.html",
    }),
    {
      // Its own prebundle cache: the desktop renderer's dev server shares
      // the app's node_modules, and one re-optimizing would leave the
      // other's pages asking for deps it has replaced.
      cacheDir: resolve(__dirname, "node_modules/.vite-web"),
      // Vite matches envPrefix entries as prefixes, so the full key names
      // from ACCOUNT_ENV_KEYS expose exactly those vars and nothing else
      // that happens to share a prefix. Every value is a public endpoint
      // or client id by design, so inlining them leaks nothing.
      envPrefix: ["VITE_", ...ACCOUNT_ENV_KEYS],
      // Env files are read from the app root, beside the desktop's.
      envDir: __dirname,
      // Distinct from the desktop renderer's dev server so both can run,
      // and one per worktree (WEB_PORT in .env.ports).
      server: {
        port: fixedDevServerPort("WEB_PORT"),
        strictPort: true,
      },
      define: buildInfoDefine(mode),
      plugins: [preloadBoot()],
      build: {
        ...reactGrabBuild,
        outDir: resolve(__dirname, "dist-web"),
        emptyOutDir: true,
        // Never inline assets as data: URIs. The deploy's CSP is strict
        // (font-src 'self', script-src 'self'), and inlined font subsets
        // would be blocked by it, so every asset ships as a real file.
        assetsInlineLimit: 0,
      },
    },
  );
});
