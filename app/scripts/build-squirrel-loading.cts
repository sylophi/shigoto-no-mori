// Renders the card Squirrel shows while the Windows installer works
// (forge.config.ts, MakerSquirrel's loadingGif) to a looping GIF.
//
//   pnpm squirrel:loading
//
// Painted from scripts/squirrel-loading.html (lib/artWindow.mts).
// Re-run this after a doubutsu palette change. ffmpeg, which has to be
// on PATH, makes the GIF from the frames.
const {
  spawnSync,
}: typeof import("node:child_process") = require("node:child_process");
const {
  mkdtempSync,
  rmSync,
  writeFileSync,
}: typeof import("node:fs") = require("node:fs");
const { tmpdir }: typeof import("node:os") = require("node:os");
const { dirname, join }: typeof import("node:path") = require("node:path");
const {
  paintArt,
  capture,
}: typeof import("./lib/artWindow.mts") = require("./lib/artWindow.mts");

const OUT = join(dirname(__dirname), "assets", "squirrel-loading.gif");

// One loop of the stripes at the app's own pace (ac-stripe-slide's
// 0.6s).
const FPS = 20;
const FRAMES = 0.6 * FPS;

paintArt("squirrel-loading.html", { width: 420, height: 232 }, async (win) => {
  await win.webContents.executeJavaScript("document.fonts.ready");
  const frames = mkdtempSync(join(tmpdir(), "squirrel-loading-"));
  try {
    for (let frame = 0; frame < FRAMES; frame++) {
      // oxlint-disable-next-line no-await-in-loop -- one window paints each frame in turn
      await win.webContents.executeJavaScript(
        `document.documentElement.style.setProperty("--frame", "${frame / FRAMES}")`,
      );
      writeFileSync(
        join(frames, `${String(frame).padStart(2, "0")}.png`),
        // oxlint-disable-next-line no-await-in-loop -- as above
        await capture(win, frame === 0 ? 400 : 60),
      );
    }
    // One palette for the whole loop and no dither, so what holds still
    // is the same pixels in every frame.
    const { status } = spawnSync(
      "ffmpeg",
      [
        "-y",
        "-loglevel",
        "error",
        "-framerate",
        String(FPS),
        "-i",
        join(frames, "%02d.png"),
        "-filter_complex",
        "split[a][b];[a]palettegen=stats_mode=full[p];[b][p]paletteuse=dither=none",
        "-loop",
        "0",
        OUT,
      ],
      { stdio: "inherit" },
    );
    if (status !== 0) throw new Error("ffmpeg could not make the GIF");
    console.log(`wrote ${OUT}`);
  } finally {
    rmSync(frames, { recursive: true, force: true });
  }
});
