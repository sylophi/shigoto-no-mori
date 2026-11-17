// Renders the dmg installer window's background art to PNG: the stable
// art, and the prerelease art carrying the app's dev-build tell
// (leaf-green wordmark plus a sticker on the card), each at 1x and 2x.
//
//   pnpm dmg:background
//
// Electron does the painting on purpose (lib/artWindow.cts):
// scripts/dmg-background.html links the app's own doubutsu.css, so the
// leaf wallpaper, the palette tokens, the sticker and stripe recipes
// and Zen Maru Gothic in the artwork are the rules the app ships.
// Re-run this after a doubutsu palette change.
//
// Window and icon geometry, and the file names, come from
// shared/packaging/dmgLayout.mts, which forge.config.ts reads too.
// Everything else about the composition lives in the html.
import type { BrowserWindow as Window } from "electron";
import type { ArtWindow } from "./lib/artWindow.cts";

type DmgLayout = typeof import("../shared/packaging/dmgLayout.mts");

const {
  mkdirSync,
  writeFileSync,
}: typeof import("node:fs") = require("node:fs");
const { dirname, join }: typeof import("node:path") = require("node:path");
const { paintArt, capture }: ArtWindow = require("./lib/artWindow.cts");

const ROOT = dirname(__dirname);

// A still frame of an animated stylesheet: the wallpaper's drift is
// stopped in css.
//
// One window renders all four images. The art is authored at 1x and
// the page scales itself, so a capture is: resize, restate which art
// and the scale, let it paint.
async function render(
  win: Window,
  layout: DmgLayout,
  prerelease: boolean,
  scale: 1 | 2,
): Promise<Buffer> {
  const size = {
    width: layout.DMG_ART.width * scale,
    height: layout.DMG_ART.height * scale,
  };
  win.setContentSize(size.width, size.height);
  await win.webContents.executeJavaScript(`
    (async () => {
      const root = document.documentElement;
      root.classList.toggle("prerelease", ${prerelease});
      root.style.setProperty("--dmg-scale", "${scale}");
      await document.fonts.ready;
    })()
  `);
  return capture(win, size, 400);
}

void import("../shared/packaging/dmgLayout.mts").then((layout) =>
  paintArt("dmg-background.html", layout.DMG_ART, async (win) => {
    // Geometry is constant across all four captures, so it goes in once.
    await win.webContents.executeJavaScript(`
      (() => {
        const vars = ${JSON.stringify({
          "--dmg-w": layout.DMG_ART.width,
          "--dmg-h": layout.DMG_ART.height,
          "--icon": layout.DMG_ICON_SIZE,
          "--icon-y": layout.DMG_ICON_Y,
          "--app-x": layout.DMG_APP_ICON.x,
          "--apps-x": layout.DMG_APPS_ICON.x,
        })};
        for (const [name, value] of Object.entries(vars)) {
          document.documentElement.style.setProperty(name, String(value));
        }
      })()
    `);

    const outDir = join(ROOT, layout.DMG_ART_DIR);
    mkdirSync(outDir, { recursive: true });
    const write = async (prerelease: boolean, scale: 1 | 2) => {
      const file = join(outDir, layout.dmgBackgroundName(prerelease, scale));
      writeFileSync(file, await render(win, layout, prerelease, scale));
      console.log(`wrote ${file}`);
    };
    // The stable and the prerelease art every run, so a design change
    // can't land on one and miss the other. appdmg finds each @2x twin
    // itself, by name.
    await write(false, 1);
    await write(false, 2);
    await write(true, 1);
    await write(true, 2);
  }),
);
