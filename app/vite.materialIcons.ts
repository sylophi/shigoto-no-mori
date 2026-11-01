// The material icons the file pickers show, at the URL they ask for
// (/material-icons/<name>.svg, @shigomori/ui's materialIcons.ts),
// for every build of the renderer tree (the desktop window, the web
// client, the fake host) and the marketing site's live frames: served
// from material-icon-theme in dev, written into the output by a build.
// A file each, fetched only when a picker shows it. The manifest names
// some icons whose only file is the package's `<name>.clone.svg`, so
// each of those answers to its bare name too.
import {
  copyFileSync,
  createReadStream,
  mkdirSync,
  readdirSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Connect, Plugin } from "vite";

const iconsDir = fileURLToPath(
  new URL("node_modules/material-icon-theme/icons", import.meta.url),
);

// Each icon's file name under /material-icons and the package's file.
function iconFiles(): Map<string, string> {
  const svgs = readdirSync(iconsDir).filter((name) => name.endsWith(".svg"));
  const files = new Map(svgs.map((name) => [name, join(iconsDir, name)]));
  for (const name of svgs) {
    if (!name.endsWith(".clone.svg")) continue;
    const bare = `${name.slice(0, -".clone.svg".length)}.svg`;
    if (!files.has(bare)) files.set(bare, join(iconsDir, name));
  }
  return files;
}

export function serveMaterialIcons(middlewares: Connect.Server): void {
  const files = iconFiles();
  middlewares.use("/material-icons", (req, res, next) => {
    const file = files.get(basename((req.url ?? "").split("?")[0] ?? ""));
    if (file === undefined) {
      next();
      return;
    }
    res.setHeader("Content-Type", "image/svg+xml");
    createReadStream(file).pipe(res);
  });
}

export function writeMaterialIcons(outDir: string): void {
  const dir = join(outDir, "material-icons");
  mkdirSync(dir, { recursive: true });
  for (const [name, file] of iconFiles()) copyFileSync(file, join(dir, name));
}

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
      serveMaterialIcons(server.middlewares);
    },
    // A dev server's close calls this too, and has no output to fill.
    closeBundle() {
      if (building) writeMaterialIcons(outDir);
    },
  };
}
