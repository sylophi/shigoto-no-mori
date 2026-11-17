// pnpm og: renders the link preview card (scripts/og.html) to
// public/img/og.jpg with the system's Chrome.
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";

const out = join(import.meta.dirname, "../public/img/og.jpg");

// The card reaches into the ui package for its stylesheet and fonts.
const browser = await chromium.launch({
  channel: "chrome",
  args: ["--allow-file-access-from-files"],
});
try {
  const page = await browser.newPage({
    viewport: { width: 1200, height: 630 },
    colorScheme: "light",
  });
  await page.goto(pathToFileURL(join(import.meta.dirname, "og.html")).href);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: out, type: "jpeg", quality: 90 });
  console.log(`wrote ${out}`);
} finally {
  await browser.close();
}
