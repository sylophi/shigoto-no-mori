// Bundles the headless host (headless/main.ts) into one CommonJS file at
// dist-headless/host.cjs, over the node-side Vite config the Electron
// builds share (vite.node.config.ts), so node runs it with node-pty
// beside it in node_modules. `--dev` builds the one `pnpm headless`
// runs from the checkout, as the dev flavor. Without it the bundle is
// built to ship, as SM_FLAVOR's flavor, at package.json's version.
//
// Run: node scripts/build-headless.mts [--dev]
import { readFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { join } from "node:path";
import { build } from "vite";
import { appRoot } from "./lib/appRoot.mts";

const packaged = !process.argv.includes("--dev");
const { version } = JSON.parse(
  await readFile(join(appRoot, "package.json"), "utf8"),
) as { version: string };

// The config is loaded as forge loads it for the Electron builds, which
// Vite warns of on every build.
process.env["VITE_CONFIG_NATIVE_IGNORE_WARNING"] = "true";
await build({
  configFile: join(appRoot, "vite.node.config.ts"),
  root: appRoot,
  mode: packaged ? "production" : "development",
  logLevel: "warn",
  define: {
    __SM_HEADLESS_PACKAGED__: JSON.stringify(packaged),
    __SM_APP_VERSION__: JSON.stringify(version),
  },
  resolve: {
    conditions: ["node"],
    mainFields: ["module", "jsnext:main", "jsnext"],
  },
  build: {
    outDir: join(appRoot, "dist-headless"),
    emptyOutDir: true,
    copyPublicDir: false,
    minify: packaged,
    lib: {
      entry: join(appRoot, "headless", "main.ts"),
      formats: ["cjs"],
      fileName: () => "host.cjs",
    },
    rollupOptions: { external: [...builtinModules] },
  },
});
console.log(`built ${join(appRoot, "dist-headless", "host.cjs")}`);
