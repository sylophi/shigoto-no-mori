// pnpm og: the link preview image (public/img/og.jpg) shot from the built
// site's hero, the headline over the hero's window as the app's views
// draw it at build time. Run after `pnpm build`. The system's Chrome
// shoots it through playwright-core, as the scene comparison does
// (app/lab/scene-compare). The Link preview workflow runs it when the
// site or the views change and opens a pull request with the new image.
import { join, resolve } from "node:path";
import { preview } from "astro";
import { chromium } from "playwright-core";

const site = resolve(import.meta.dirname, "..");
const out = join(site, "public/img/og.jpg");

const server = await preview({ root: site, logLevel: "warn" });

const browser = await chromium.launch({ channel: "chrome" });
try {
  // The page as a link preview shows it: 1200 by 630, light, still, and
  // without its scripts, so the hero is the one drawn at build time.
  const page = await browser.newPage({
    viewport: { width: 1200, height: 630 },
    colorScheme: "light",
    reducedMotion: "reduce",
    javaScriptEnabled: false,
  });
  await page.goto(`http://localhost:${server.port}/`, {
    waitUntil: "networkidle",
  });
  await page.evaluate(() => document.fonts.ready);
  // The headline over the window's first hundred pixels.
  const frame = await page.locator(".stage-main").boundingBox();
  if (!frame) throw new Error("no hero window (.stage-main) on the page");
  await page.screenshot({
    path: out,
    type: "jpeg",
    quality: 85,
    clip: { x: 0, y: frame.y - 530, width: 1200, height: 630 },
    animations: "disabled",
    fullPage: true,
  });
  console.log(`wrote ${out}`);
} finally {
  await browser.close();
  await server.stop();
}
