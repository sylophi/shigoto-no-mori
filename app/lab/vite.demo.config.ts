// The UI lab built for the live app frames on shigomori.com
// (lab/demo/main.tsx): the desktop lab's config, rooted at lab/demo
// and served from the site's /demo/. The marketing build runs it with
// --outDir pointed into its own public/ (marketing/README.md).
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import { labBaseConfig } from "./vite.base";

// The villager data a checkout may hold (lab/villagerData.ts globs the
// gitignored lab/villager-data) stays out, so the site builds the same
// on every machine and never ships Nookipedia's faces, which are the
// app's to download, not the repo's to publish. Its globs then match
// nothing, and the data reads as not downloaded.
function withoutVillagerData(): Plugin {
  return {
    name: "demo-without-villager-data",
    enforce: "pre",
    transform(code, id) {
      if (!id.endsWith("/lab/villagerData.ts")) return null;
      return code.replaceAll("./villager-data/", "./villager-data-left-out/");
    },
  };
}

const base = labBaseConfig({ portKey: "LAB_PORT", entry: "index.html" });

export default defineConfig({
  ...base,
  root: resolve(__dirname, "demo"),
  base: "/demo/",
  // The app-root public/: the material icons the file pickers show,
  // which materialIcons.ts finds under the base URL.
  publicDir: resolve(__dirname, "../public"),
  plugins: [withoutVillagerData(), ...(base.plugins ?? [])],
  build: {
    emptyOutDir: true,
    // Every asset a file of its own, as in the web build: an inlined
    // data: URL (the smaller font subsets) would break the site's CSP.
    assetsInlineLimit: 0,
  },
});
