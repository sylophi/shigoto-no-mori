// Video harness for the UI lab, the moving-picture twin of shoot.mjs.
// Usage:
//   node lab/record.mjs <takes.json> [outDir]
// Same prerequisites as shoot.mjs (system Chrome, LAB_ORIGIN), plus
// Playwright's own ffmpeg for the capture:
// `pnpm exec playwright-core install ffmpeg`, once. Output is
// webm; set FFMPEG to an ffmpeg binary to also get an mp4 beside it.
// Each take: { file, query, width?, height?, waitMs?, actions? }
//   actions: [{ click: "playwright locator" } | { press: "Key" }
//            | { type: "text" } | { paste: "text" }
//            | { waitFor: "visible text" } | { waitMs: n } | { evaluate: "js" }]
// `type` keys the text into whatever has focus at a readable pace, and
// `paste` replaces the focused input's text in one go, the way a
// clipboard would (a URL typed out key by key is a long watch).
// A click glides a visible cursor to the target first, since a headless
// capture has no pointer of its own, and `waitFor` blocks on text so a
// take can wait out the lab's posed progress. The final frame lingers
// briefly so the outcome is readable before the file ends.
/* oxlint-disable no-await-in-loop */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";

const ORIGIN = process.env.LAB_ORIGIN ?? "http://localhost:5191/";
const [, , takesPath, outDir = "lab"] = process.argv;
const takes = JSON.parse(readFileSync(takesPath, "utf8"));

// Drawn in the page: a dot that follows the mouse and shrinks on press.
const CURSOR = () => {
  const dot = document.createElement("div");
  Object.assign(dot.style, {
    position: "fixed",
    left: "0px",
    top: "0px",
    width: "18px",
    height: "18px",
    borderRadius: "50%",
    background: "rgba(255,255,255,0.85)",
    border: "2px solid rgba(0,0,0,0.6)",
    boxShadow: "0 0 8px rgba(0,0,0,0.5)",
    pointerEvents: "none",
    zIndex: "2147483647",
    transform: "translate(-50%,-50%)",
    transition: "transform 80ms",
  });
  const mount = () => document.body.appendChild(dot);
  if (document.body) mount();
  else addEventListener("DOMContentLoaded", mount);
  addEventListener(
    "mousemove",
    (event) => {
      dot.style.left = `${event.clientX}px`;
      dot.style.top = `${event.clientY}px`;
    },
    true,
  );
  addEventListener(
    "mousedown",
    () => {
      dot.style.transform = "translate(-50%,-50%) scale(0.6)";
    },
    true,
  );
  addEventListener(
    "mouseup",
    () => {
      dot.style.transform = "translate(-50%,-50%)";
    },
    true,
  );
};

const browser = await chromium.launch({ channel: "chrome", headless: true });

for (const take of takes) {
  const width = take.width ?? 1440;
  const height = take.height ?? 900;
  const captureDir = join(outDir, `.capture-${take.file}`);
  const context = await browser.newContext({
    viewport: { width, height },
    recordVideo: { dir: captureDir, size: { width, height } },
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (err) => errors.push(String(err).slice(0, 200)));
  await page.addInitScript(CURSOR);
  await page.goto(ORIGIN + (take.query ?? ""), { waitUntil: "load" });
  // Past a cold vite server's slow first mount (see shoot.mjs).
  await page.locator("#root > *").first().waitFor({ timeout: 60_000 });
  await page.mouse.move(width / 2, height / 2);
  await page.waitForTimeout(take.waitMs ?? 1500);
  for (const action of take.actions ?? []) {
    try {
      if (action.click) {
        const target = page.locator(action.click).first();
        await target.waitFor({ state: "visible", timeout: 10_000 });
        const box = await target.boundingBox();
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, {
          steps: 28,
        });
        await page.waitForTimeout(350);
        await page.mouse.down();
        await page.waitForTimeout(90);
        await page.mouse.up();
        await page.waitForTimeout(action.settleMs ?? 1200);
      }
      if (action.press) await page.keyboard.press(action.press);
      if (action.type) await page.keyboard.type(action.type, { delay: 45 });
      if (action.paste) {
        await page.keyboard.press("ControlOrMeta+a");
        await page.keyboard.insertText(action.paste);
      }
      if (action.waitFor) {
        await page
          .getByText(action.waitFor)
          .first()
          .waitFor({ timeout: 30_000 });
      }
      if (action.evaluate) await page.evaluate(action.evaluate);
      if (action.waitMs) await page.waitForTimeout(action.waitMs);
    } catch (error) {
      errors.push(
        `action failed: ${JSON.stringify(action)} ${String(error).slice(0, 120)}`,
      );
    }
  }
  await page.waitForTimeout(2500);
  await context.close();
  const captured = readdirSync(captureDir).find((name) =>
    name.endsWith(".webm"),
  );
  const webm = join(outDir, `${take.file}.webm`);
  renameSync(join(captureDir, captured), webm);
  rmSync(captureDir, { recursive: true, force: true });
  if (process.env.FFMPEG) {
    execFileSync(process.env.FFMPEG, [
      "-y",
      "-loglevel",
      "error",
      "-i",
      webm,
      "-c:v",
      "libx264",
      "-crf",
      "20",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      join(outDir, `${take.file}.mp4`),
    ]);
  }
  console.log(
    `take ${take.file}${errors.length ? ` PAGE ERRORS: ${errors.join(" | ")}` : ""}`,
  );
}

await browser.close();
