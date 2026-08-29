// Screenshot harness for the UI lab. Usage:
//   node lab/shoot.mjs <shots.json> [outDir]
// Needs `playwright-core` resolvable (it is not a repo dependency —
// run from a scratch dir that has it installed, or point NODE_PATH at
// one) and system Chrome. LAB_ORIGIN overrides the default desktop
// lab origin (set it to the web flavor's port for web-shell shots).
// Each shot: { file, query, width?, height?, waitMs?, actions? }
//   query: the lab pose querystring, e.g. "?theme=light&doubutsu=1&to=/devices"
//   actions: [{ click: "css or text selector" } | { press: "Key" } | { waitMs: n } | { evaluate: "js" }]
// Shots are serial by design: one page at a time keeps captures
// deterministic, so the sequential awaits are the point.
/* oxlint-disable no-await-in-loop */
import { readFileSync } from "node:fs";
import { chromium } from "playwright-core";

const ORIGIN = process.env.LAB_ORIGIN ?? "http://localhost:5191/";
const [, , shotsPath, outDir = "lab"] = process.argv;
const shots = JSON.parse(readFileSync(shotsPath, "utf8"));

const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
});

for (const shot of shots) {
  const context = await browser.newContext({
    viewport: { width: shot.width ?? 1440, height: shot.height ?? 900 },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (err) => errors.push(String(err).slice(0, 200)));
  await page.goto(ORIGIN + (shot.query ?? ""), { waitUntil: "load" });
  await page.waitForTimeout(shot.waitMs ?? 900);
  for (const action of shot.actions ?? []) {
    try {
      if (action.click) await page.click(action.click, { timeout: 5000 });
      if (action.press) await page.keyboard.press(action.press);
      if (action.evaluate) await page.evaluate(action.evaluate);
      if (action.waitMs) await page.waitForTimeout(action.waitMs);
    } catch (error) {
      errors.push(
        `action failed: ${JSON.stringify(action)} ${String(error).slice(0, 120)}`,
      );
    }
  }
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${outDir}/${shot.file}.png` });
  console.log(
    `shot ${shot.file}${errors.length ? ` PAGE ERRORS: ${errors.join(" | ")}` : ""}`,
  );
  await context.close();
}

await browser.close();
