// The UI lab built for the live app frames on shigomori.com
// (lab/demo/main.tsx): the desktop lab's config, rooted at lab/demo
// and served from the site's /demo/. The marketing build runs it with
// --outDir pointed into its own public/ (marketing/README.md).
import { resolve } from "node:path";
import { defineConfig } from "vite";
import { labBaseConfig } from "./vite.base";

const base = labBaseConfig({ portKey: "LAB_PORT", entry: "index.html" });

export default defineConfig({
  ...base,
  root: resolve(__dirname, "demo"),
  base: "/demo/",
  // The app-root public/: the material icons the file pickers show,
  // which materialIcons.ts finds under the base URL.
  publicDir: resolve(__dirname, "../public"),
  build: { emptyOutDir: true },
});
