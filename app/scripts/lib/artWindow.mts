// A hidden Electron window for painting installer art: a page under
// scripts/ that links the app's own doubutsu.css (packages/ui/src/styles),
// so the artwork follows the rules the app ships rather than copies
// that can drift.
//
// The script that runs under electron has to be CommonJS (.cts): an
// ESM main process never sees Electron's `ready` event fire
// (app.whenReady() simply never settles). It can require this.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import electron, { type BrowserWindow } from "electron";

const SCRIPTS = join(import.meta.dirname, "..");

// Loads scripts/<page> at the given size, hands the window to `paint`,
// and exits the process with how that went.
export function paintArt(
  page: string,
  size: { readonly width: number; readonly height: number },
  paint: (win: BrowserWindow) => Promise<void>,
): void {
  // A terminal launched from an Electron app (any agent harness, say)
  // exports ELECTRON_RUN_AS_NODE=1, which makes the electron binary
  // behave as plain node. "electron" then hands back a path string
  // instead of the api, and nothing here works. Relaunch with it
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

// The page as it stands, once the webfont and the paint have had
// `settleMs` to settle, at the window's size. The resize resamples
// even at that size, so the committed art holds its pixels only with
// it in.
export async function capture(
  win: BrowserWindow,
  settleMs: number,
): Promise<Buffer> {
  await new Promise((resolve) => setTimeout(resolve, settleMs));
  const [width = 0, height = 0] = win.getContentSize();
  const image = await win.webContents.capturePage();
  return image.resize({ width, height, quality: "best" }).toPNG();
}
