// Renders the dmg installer window's background art to PNG: the stable
// art, and the prerelease art carrying the app's dev-build tell
// (leaf-green wordmark plus a sticker on the card), each at 1x and 2x.
//
//   pnpm dmg:background
//
// Painted from scripts/dmg-background.html (lib/artWindow.mts). Re-run
// this after a doubutsu palette change.
//
// Window and icon geometry, and the file names, come from
// shared/packaging/dmgLayout.mts, which forge.config.ts reads too.
// Everything else about the composition lives in the html.
import type { BrowserWindow } from "electron";

const {
  mkdirSync,
  writeFileSync,
}: typeof import("node:fs") = require("node:fs");
const { dirname, join }: typeof import("node:path") = require("node:path");
const {
  DMG_ART,
  DMG_ART_DIR,
  DMG_ICON_SIZE,
  DMG_ICON_Y,
  DMG_APP_ICON,
  DMG_APPS_ICON,
  dmgBackgroundName,
}: typeof import("../shared/packaging/dmgLayout.mts") = require("../shared/packaging/dmgLayout.mts");
const {
  paintArt,
  capture,
}: typeof import("./lib/artWindow.mts") = require("./lib/artWindow.mts");

const ROOT = dirname(__dirname);

// One window renders all four images. The art is authored at 1x and
// the page scales itself, so a capture is: resize, restate which art
// and the scale, let it paint.
async function render(
  win: BrowserWindow,
  prerelease: boolean,
  scale: 1 | 2,
): Promise<Buffer> {
  win.setContentSize(DMG_ART.width * scale, DMG_ART.height * scale);
  await win.webContents.executeJavaScript(`
    (async () => {
      const root = document.documentElement;
      root.classList.toggle("prerelease", ${prerelease});
      root.style.setProperty("--dmg-scale", "${scale}");
      await document.fonts.ready;
    })()
  `);
  return capture(win, 400);
}

paintArt("dmg-background.html", DMG_ART, async (win) => {
  // Geometry is constant across all four captures, so it goes in once.
  await win.webContents.executeJavaScript(`
    (() => {
      const vars = ${JSON.stringify({
        "--dmg-w": DMG_ART.width,
        "--dmg-h": DMG_ART.height,
        "--icon": DMG_ICON_SIZE,
        "--icon-y": DMG_ICON_Y,
        "--app-x": DMG_APP_ICON.x,
        "--apps-x": DMG_APPS_ICON.x,
      })};
      for (const [name, value] of Object.entries(vars)) {
        document.documentElement.style.setProperty(name, String(value));
      }
    })()
  `);

  const outDir = join(ROOT, DMG_ART_DIR);
  mkdirSync(outDir, { recursive: true });
  const write = async (prerelease: boolean, scale: 1 | 2) => {
    const file = join(outDir, dmgBackgroundName(prerelease, scale));
    writeFileSync(file, await render(win, prerelease, scale));
    console.log(`wrote ${file}`);
  };
  // The stable and the prerelease art every run, so a design change
  // can't land on one and miss the other. appdmg finds each @2x twin
  // itself, by name.
  await write(false, 1);
  await write(false, 2);
  await write(true, 1);
  await write(true, 2);
});
