#!/usr/bin/env node
// Copies material-icon-theme's SVG icons into public/material-icons/ so
// Vite serves them as plain static assets (one HTTP request per icon that's
// actually displayed) instead of generating ~1238 dev-server module wrappers
// from an eager `import.meta.glob`. See src/lib/materialIcons.ts.
//
// Idempotent: skips copying when the destination is already in sync with the
// source by mtime + size. Runs as a postinstall hook so the icons are in
// place before the first `pnpm dev` / `pnpm package` of a fresh checkout.

import { copyFile, mkdir, readdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "node_modules", "material-icon-theme", "icons");
const DEST = join(ROOT, "public", "material-icons");

async function maybeStat(path) {
  try {
    return await stat(path);
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

async function main() {
  const srcStat = await maybeStat(SRC);
  if (!srcStat) {
    // material-icon-theme isn't installed yet — pnpm may run postinstall
    // before all deps are linked in some workspace layouts. Nothing to do.
    return;
  }

  await mkdir(DEST, { recursive: true });
  const [srcFiles, destFiles] = await Promise.all([
    readdir(SRC),
    readdir(DEST),
  ]);

  const svgs = srcFiles.filter((f) => f.endsWith(".svg"));
  const destSet = new Set(destFiles);

  let copied = 0;
  let removed = 0;
  await Promise.all(
    svgs.map(async (name) => {
      const from = join(SRC, name);
      const to = join(DEST, name);
      const [fromStat, toStat] = await Promise.all([stat(from), maybeStat(to)]);
      if (
        toStat &&
        toStat.size === fromStat.size &&
        toStat.mtimeMs >= fromStat.mtimeMs
      ) {
        return;
      }
      await copyFile(from, to);
      copied++;
    }),
  );

  // Drop stale files that aren't in the current source (e.g. after upgrading
  // material-icon-theme to a version that removed an icon).
  const svgSet = new Set(svgs);
  await Promise.all(
    [...destSet].map(async (name) => {
      if (svgSet.has(name)) return;
      if (!name.endsWith(".svg")) return;
      const { rm } = await import("node:fs/promises");
      await rm(join(DEST, name));
      removed++;
    }),
  );

  if (copied > 0 || removed > 0) {
    console.log(
      `[icons] synced material-icon-theme → public/material-icons (` +
        `copied ${copied}, removed ${removed}, total ${svgs.length})`,
    );
  }
}

main().catch((err) => {
  console.error("[icons] failed to sync material-icon-theme:", err);
  process.exit(1);
});
