// Renders the dmg installer window's background art to PNG, in both
// flavors: the stable one, and the prerelease one carrying the app's
// dev-build tell (leaf-green wordmark plus a sticker on the card).
//
//   pnpm dmg:background
//
// Electron does the painting on purpose: scripts/dmg-background.html
// links the app's own renderer/doubutsu.css, so the leaf wallpaper, the
// palette tokens, the sticker and stripe recipes and Zen Maru Gothic in
// the artwork are the rules the app ships rather than copies that can
// drift. Re-run this after a doubutsu palette change -- `pnpm dmg:check`
// (lefthook pre-commit) fails when the committed art predates one.
//
// Window and icon geometry, and the file names, come from
// shared/dmgLayout.mts, which forge.config.ts reads too. Everything else
// about the composition lives in the html.
//
// CommonJS, unlike the rest of scripts/: an ESM main process never sees
// Electron's `ready` event fire (app.whenReady() simply never settles),
// so the entry point has to be .cjs. The two ESM modules it needs come
// in by dynamic import.
const { spawnSync } = require("node:child_process");
const { mkdirSync, writeFileSync } = require("node:fs");
const { dirname, join } = require("node:path");
const electron = require("electron");

const ROOT = dirname(__dirname);

// A terminal launched from an Electron app (any agent harness, say)
// exports ELECTRON_RUN_AS_NODE=1, which makes the electron binary
// behave as plain node -- `require("electron")` then hands back a path
// string instead of the api, and nothing here works. Relaunch with it
// cleared rather than failing with a puzzling TypeError.
if (typeof electron === "string") {
  const { status } = spawnSync(process.execPath, process.argv.slice(1), {
    stdio: "inherit",
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "" },
  });
  process.exit(status ?? 1);
}

const { app, BrowserWindow } = electron;

// Capture at the requested size on every machine, retina or not:
// without this the page renders at the host display's scale factor and
// the art would depend on whose laptop rendered it.
app.commandLine.appendSwitch("force-device-scale-factor", "1");

// A still frame of an animated stylesheet: the wallpaper's drift is
// stopped in css, but the webfont and the first paint still need a beat
// to settle before the capture.
//
// One window renders all four images -- the art is authored at 1x and
// the page scales itself, so a capture is: resize, restate the flavor
// and the scale, let it paint. (A second BrowserWindow in the same run
// fails to load at all, so reuse is also the only thing that works.)
async function render(win, layout, prerelease, scale) {
  const width = layout.DMG_ART.width * scale;
  const height = layout.DMG_ART.height * scale;
  win.setContentSize(width, height);
  await win.webContents.executeJavaScript(`
    (async () => {
      const root = document.documentElement;
      root.classList.toggle("prerelease", ${prerelease});
      root.style.setProperty("--dmg-scale", "${scale}");
      await document.fonts.ready;
    })()
  `);
  await new Promise((resolve) => setTimeout(resolve, 400));
  // resize is a no-op while the scale factor above holds. It keeps the
  // output pinned to the requested size if that ever stops being true.
  const image = (await win.webContents.capturePage()).resize({
    width,
    height,
    quality: "best",
  });
  return image.toPNG();
}

app
  .whenReady()
  .then(async () => {
    const layout = await import("../shared/dmgLayout.mts");
    const { artInputsHash, ART_STAMP_FILE } =
      await import("./check-dmg-art.mjs");
    const outDir = join(ROOT, layout.DMG_ART_DIR);
    const win = new BrowserWindow({
      // render() sets the real size before every capture.
      width: layout.DMG_ART.width,
      height: layout.DMG_ART.height,
      useContentSize: true,
      show: false,
      frame: false,
      webPreferences: {
        // A hidden window otherwise stops driving frames, which the
        // paint above waits on.
        backgroundThrottling: false,
        // The page loads the stylesheet and the webfont from elsewhere
        // in the repo over file://.
        webSecurity: false,
      },
    });
    await win.loadFile(join(ROOT, "scripts", "dmg-background.html"));
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

    mkdirSync(outDir, { recursive: true });
    const write = async (prerelease, scale) => {
      const file = join(outDir, layout.dmgBackgroundName(prerelease, scale));
      writeFileSync(file, await render(win, layout, prerelease, scale));
      console.log(`wrote ${file}`);
    };
    // Both flavors every run, so a design change can't land on one and
    // miss the other. appdmg finds each @2x twin itself, by name.
    await write(false, 1);
    await write(false, 2);
    await write(true, 1);
    await write(true, 2);

    // Stamp what these pixels were rendered from, so dmg:check can tell
    // when they've fallen behind it.
    writeFileSync(ART_STAMP_FILE, `${artInputsHash()}\n`);
    console.log(`wrote ${ART_STAMP_FILE}`);
    process.exit(0);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
