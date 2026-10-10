// pnpm og: the link preview image (public/img/og.jpg) shot from the built
// site's hero, the headline over the hero's window as the app's views
// draw it at build time. Run after `pnpm build`. The system's Chrome
// shoots it through playwright-core, as the scene comparison does
// (app/lab/scene-compare). The Link preview workflow runs it when the
// site or the views change and opens a pull request with the new image.
import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { extname, join, resolve } from "node:path";
import { chromium } from "playwright-core";

const site = resolve(import.meta.dirname, "..");
const dist = join(site, "dist");
const out = join(site, "public/img/og.jpg");
const TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".woff2": "font/woff2",
};

if (!existsSync(join(dist, "index.html"))) {
  throw new Error("no built site in dist/: run pnpm build first");
}

// The built site as it is served: its pages and assets by path.
const server = createServer((req, res) => {
  let file = join(
    dist,
    decodeURIComponent((req.url ?? "/").split("?")[0] ?? "/"),
  );
  if (existsSync(file) && statSync(file).isDirectory())
    file = join(file, "index.html");
  if (!file.startsWith(dist) || !existsSync(file)) {
    res.statusCode = 404;
    res.end();
    return;
  }
  res.setHeader(
    "Content-Type",
    TYPES[extname(file)] ?? "application/octet-stream",
  );
  res.end(readFileSync(file));
});
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
const { port } = server.address() as AddressInfo;

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
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "networkidle" });
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
  server.close();
}
