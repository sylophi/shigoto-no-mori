// The material icons the file pickers show, for every build of the
// renderer tree (the desktop window, the web client, the fake host).
// scripts/copy-material-icons.mts stages them in the app-root public/
// (with the bare-name aliases of the package's .clone.svg files the
// manifest asks for), which none of those builds serves: their public
// dir is web/public, for the theme boot script. Without them every icon
// request falls through to index.html. So that directory is served from
// where it is in dev and copied into the output. A build that finds it
// missing fails, where skipping would ship every icon broken. The
// `web:build` script stages the icons itself first rather than trusting
// the postinstall to have run: a deploy that restores its install from
// a build cache (Vercel's) skips lifecycle scripts.
import { cpSync, createReadStream, existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

const materialIconsDir = fileURLToPath(
  new URL("public/material-icons", import.meta.url),
);

export function materialIcons(): Plugin {
  let outDir = "";
  let building = false;
  return {
    name: "sm-material-icons",
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
      building = config.command === "build";
    },
    configureServer(server) {
      server.middlewares.use("/material-icons", (req, res, next) => {
        const [path = ""] = (req.url ?? "").split("?");
        const file = join(materialIconsDir, basename(path));
        if (!file.endsWith(".svg") || !existsSync(file)) {
          next();
          return;
        }
        res.setHeader("Content-Type", "image/svg+xml");
        createReadStream(file).pipe(res);
      });
    },
    // A dev server's close calls this too, and has no output to fill.
    closeBundle() {
      if (!building) return;
      if (!existsSync(materialIconsDir)) {
        throw new Error(
          `no material icons at ${materialIconsDir}: run node scripts/copy-material-icons.mts`,
        );
      }
      cpSync(materialIconsDir, join(outDir, "material-icons"), {
        recursive: true,
      });
    },
  };
}
