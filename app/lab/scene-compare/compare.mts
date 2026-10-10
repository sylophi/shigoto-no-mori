// pnpm scenes:compare [--base <ref>] [--threshold <pixels>]: every scene,
// light and dark, drawn by the working tree and by a base ref, and the
// pairs that differ written to a report (README.md beside this file).
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { chromium, type Browser, type Page } from "playwright-core";

const { values } = parseArgs({
  options: {
    base: { type: "string", default: "origin/release/v3" },
    threshold: { type: "string", default: "20" },
  },
});
const base = values.base;
const threshold = Number(values.threshold);
const THEMES = ["light", "dark"] as const;
// How far a channel may move before a pixel counts as changed: enough
// to absorb the rounding of a gradient, not enough to hide a colour.
const CHANNEL_TOLERANCE = 16;

const appDir = resolve(import.meta.dirname, "../..");
const repo = resolve(appDir, "..");
const out = join(import.meta.dirname, "report");
const started = Date.now();

const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();

// The base, checked out beside the working tree. realpath: macOS's
// temp dir is behind a symlink, which Vite resolves its way out of and
// then serves nothing from.
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "scenes-compare-")));
const baseCheckout = join(scratch, "base");
const servers: ChildProcess[] = [];
let browser: Browser | undefined;

function cleanUp(): void {
  for (const server of servers) {
    if (server.pid) process.kill(-server.pid);
  }
  try {
    git("worktree", "remove", "--force", baseCheckout);
  } catch {
    // Never added: the ref did not resolve.
  }
  rmSync(scratch, { recursive: true, force: true });
}
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    cleanUp();
    process.exit(130);
  });
}

function freePort(): Promise<number> {
  return new Promise((done) => {
    const server = createServer().listen(0, () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => done(port));
    });
  });
}

// The desktop fake host's server, whose /scenes.html draws one scene.
async function serve(checkout: string): Promise<string> {
  const port = await freePort();
  servers.push(
    spawn(
      "node_modules/.bin/vite",
      ["--config", "lab/fake-host/vite.config.ts", "--port", String(port)],
      { cwd: join(checkout, "app"), detached: true, stdio: "ignore" },
    ),
  );
  const origin = `http://localhost:${port}`;
  for (let tries = 0; tries < 120; tries += 1) {
    // oxlint-disable-next-line no-await-in-loop -- polls until the server answers
    const ready = await fetch(`${origin}/scenes.html`).then(
      (response) => response.ok,
      () => false,
    );
    if (ready) return origin;
    // oxlint-disable-next-line no-await-in-loop -- see above
    await new Promise((wait) => setTimeout(wait, 500));
  }
  throw new Error(`the fake host in ${checkout} did not start`);
}

// The viewer's list, loaded twice: the first load is where Vite finds
// and bundles the dependencies, and reloads the page once it has.
async function sceneNames(page: Page, origin: string): Promise<string[]> {
  await page.goto(`${origin}/scenes.html`, { waitUntil: "networkidle" });
  await page.goto(`${origin}/scenes.html`, { waitUntil: "networkidle" });
  return page
    .locator('a[href*="scene="]')
    .evaluateAll((links) =>
      links.map((link) =>
        new URL((link as HTMLAnchorElement).href).searchParams.get("scene"),
      ),
    )
    .then((names) => names.filter((name) => name !== null));
}

// The terminal's canvas is masked rather than its scenes skipped:
// headless Chrome draws its WebGL blank, and the rest of the scene
// still counts.
async function shoot(
  page: Page,
  origin: string,
  scene: string,
  theme: string,
): Promise<Buffer> {
  await page.goto(`${origin}/scenes.html?scene=${scene}&theme=${theme}`);
  await page
    .waitForLoadState("networkidle", { timeout: 10_000 })
    .catch(() => {});
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
  return page.locator("#root").screenshot({
    animations: "disabled",
    mask: [page.locator(".xterm canvas")],
  });
}

type Difference = { pixels: number; diff?: string };

// Compared in a blank page, on a canvas, so no image library is needed:
// the count of pixels that changed, and an image of them in red over a
// faded copy of the base. A change of size is all difference.
function compare(
  page: Page,
  baseShot: Buffer,
  headShot: Buffer,
): Promise<Difference> {
  return page.evaluate(
    async ([a, b, tolerance]) => {
      // oxlint-disable-next-line consistent-function-scoping -- this runs in the page, which sees nothing outside the function
      const load = async (png: string) =>
        createImageBitmap(
          await (await fetch(`data:image/png;base64,${png}`)).blob(),
        );
      const [before, after] = await Promise.all([load(a), load(b)]);
      if (before.width !== after.width || before.height !== after.height) {
        return { pixels: Math.max(before.width * before.height, 1) };
      }
      const { width, height } = before;
      const draw = (image?: ImageBitmap) => {
        const canvas = new OffscreenCanvas(width, height);
        const context = canvas.getContext("2d");
        if (!context) throw new Error("no 2d canvas");
        if (image) context.drawImage(image, 0, 0);
        return { canvas, context };
      };
      const x = draw(before).context.getImageData(0, 0, width, height).data;
      const y = draw(after).context.getImageData(0, 0, width, height).data;
      const { canvas, context } = draw();
      const marked = context.createImageData(width, height);
      let pixels = 0;
      for (let i = 0; i < x.length; i += 4) {
        let changed = false;
        for (let c = 0; c < 4; c += 1) {
          if (Math.abs((x[i + c] ?? 0) - (y[i + c] ?? 0)) > tolerance) {
            changed = true;
          }
        }
        if (changed) pixels += 1;
        const grey = ((x[i] ?? 0) + (x[i + 1] ?? 0) + (x[i + 2] ?? 0)) / 3;
        marked.data.set(changed ? [255, 0, 0, 255] : [grey, grey, grey, 64], i);
      }
      if (pixels === 0) return { pixels };
      context.putImageData(marked, 0, 0);
      const blob = await canvas.convertToBlob({ type: "image/png" });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return { pixels, diff: btoa(binary) };
    },
    [
      baseShot.toString("base64"),
      headShot.toString("base64"),
      CHANNEL_TOLERANCE,
    ] as const,
  );
}

try {
  const baseCommit = git("rev-parse", "--short", base);
  const headCommit = git("rev-parse", "--short", "HEAD");
  const dirty = git("status", "--porcelain") !== "";
  console.log(`base ${base} (${baseCommit}), installing…`);
  git("worktree", "add", "--detach", baseCheckout, base);
  execFileSync(
    "pnpm",
    ["install", "--frozen-lockfile", "--ignore-scripts", "--prefer-offline"],
    { cwd: baseCheckout, stdio: "ignore" },
  );

  const [baseOrigin, headOrigin] = await Promise.all([
    serve(baseCheckout),
    serve(repo),
  ]);
  browser = await chromium.launch({ channel: "chrome" });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    reducedMotion: "reduce",
  });
  const [basePage, headPage, diffPage] = await Promise.all([
    context.newPage(),
    context.newPage(),
    context.newPage(),
  ]);
  const [baseScenes, headScenes] = await Promise.all([
    sceneNames(basePage, baseOrigin),
    sceneNames(headPage, headOrigin),
  ]);
  const scenes = headScenes.filter((name) => baseScenes.includes(name));
  const added = headScenes.filter((name) => !baseScenes.includes(name));
  const removed = baseScenes.filter((name) => !headScenes.includes(name));

  rmSync(out, { recursive: true, force: true });
  for (const dir of ["base", "head", "diff"]) {
    mkdirSync(join(out, dir), { recursive: true });
  }
  const differing: { shot: string; pixels: number }[] = [];
  for (const scene of scenes) {
    for (const theme of THEMES) {
      const shot = `${theme}-${scene}`;
      // oxlint-disable-next-line no-await-in-loop -- one page a side, so the shots go one after another
      const [before, after] = await Promise.all([
        shoot(basePage, baseOrigin, scene, theme),
        shoot(headPage, headOrigin, scene, theme),
      ]);
      // oxlint-disable-next-line no-await-in-loop -- see above
      const { pixels, diff } = await compare(diffPage, before, after);
      if (pixels <= threshold) continue;
      differing.push({ shot, pixels });
      writeFileSync(join(out, "base", `${shot}.png`), before);
      writeFileSync(join(out, "head", `${shot}.png`), after);
      if (diff) {
        writeFileSync(
          join(out, "diff", `${shot}.png`),
          Buffer.from(diff, "base64"),
        );
      }
      console.log(`differs  ${shot}  ${pixels} px`);
    }
  }

  const seconds = Math.round((Date.now() - started) / 1000);
  const total = scenes.length * THEMES.length;
  const lines = [
    "# Scene comparison",
    "",
    `Base \`${base}\` (${baseCommit}) against the working tree (${headCommit}${dirty ? ", with uncommitted changes" : ""}).`,
    `${differing.length} of ${total} shots differ by more than ${threshold} pixels. Took ${seconds} s.`,
    "",
  ];
  if (differing.length > 0) {
    lines.push("| Shot | Pixels | Images |", "| --- | --- | --- |");
    for (const { shot, pixels } of differing) {
      lines.push(
        `| ${shot} | ${pixels} | [base](base/${shot}.png), [head](head/${shot}.png), [diff](diff/${shot}.png) |`,
      );
    }
    lines.push("");
  }
  if (added.length > 0) lines.push(`New scenes: ${added.join(", ")}.`, "");
  if (removed.length > 0)
    lines.push(`Removed scenes: ${removed.join(", ")}.`, "");
  writeFileSync(join(out, "report.md"), lines.join("\n"));
  console.log(
    `${differing.length} of ${total} shots differ (${seconds} s): ${join(out, "report.md")}`,
  );
  process.exitCode = differing.length > 0 ? 1 : 0;
} finally {
  await browser?.close();
  cleanUp();
}
