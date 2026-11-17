// A hidden Electron window for painting installer art: a page under
// scripts/ that links the app's own doubutsu.css (packages/ui/src/styles),
// so the artwork follows the rules the app ships rather than copies
// that can drift.
//
// CommonJS, unlike the rest of scripts/: an ESM main process never sees
// Electron's `ready` event fire (app.whenReady() simply never settles),
// so an art script and this have to be .cts. An ESM module one needs
// comes in by dynamic import.
import type { BrowserWindow as Window } from "electron";

const {
  spawnSync,
}: typeof import("node:child_process") = require("node:child_process");
const { dirname, join }: typeof import("node:path") = require("node:path");
const electron: typeof import("electron") | string = require("electron");

const SCRIPTS = dirname(__dirname);

// Loads scripts/<page> at the given size, hands the window to `paint`,
// and exits the process with how that went.
function paintArt(
  page: string,
  size: { readonly width: number; readonly height: number },
  paint: (win: Window) => Promise<void>,
): void {
  // A terminal launched from an Electron app (any agent harness, say)
  // exports ELECTRON_RUN_AS_NODE=1, which makes the electron binary
  // behave as plain node. `require("electron")` then hands back a path
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

  app
    .whenReady()
    .then(async () => {
      // One window per run: a second BrowserWindow in the same run
      // fails to load at all.
      const win = new BrowserWindow({
        ...size,
        useContentSize: true,
        show: false,
        frame: false,
        webPreferences: {
          // A hidden window otherwise stops driving frames, which a
          // capture waits on.
          backgroundThrottling: false,
          // The page loads the stylesheet and the webfont from elsewhere
          // in the repo over file://.
          webSecurity: false,
        },
      });
      await win.loadFile(join(SCRIPTS, page));
      await paint(win);
      process.exit(0);
    })
    .catch((error: unknown) => {
      console.error(error);
      process.exit(1);
    });
}

// The page as it stands, at exactly this size. The wait is for the
// webfont and the paint to settle. resize is a no-op while the scale
// factor above holds, and keeps the output pinned to the requested
// size if that ever stops being true.
async function capture(
  win: Window,
  size: { readonly width: number; readonly height: number },
  settleMs: number,
): Promise<Buffer> {
  await new Promise((resolve) => setTimeout(resolve, settleMs));
  const image = await win.webContents.capturePage();
  return image.resize({ ...size, quality: "best" }).toPNG();
}

module.exports = { paintArt, capture };
// What a require of this hands back, which TypeScript can't read off
// the line above.
export type ArtWindow = {
  readonly paintArt: typeof paintArt;
  readonly capture: typeof capture;
};
