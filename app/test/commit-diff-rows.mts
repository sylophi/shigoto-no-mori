// Durable proof for the commit diff page's rows
// (renderer/components/diff/DiffPage.tsx) against a REAL repository: a
// commit git made, changing a long file and four short ones, read with
// the host's own commitDiff, drawn by the real renderer (the lab's fake
// host, in Chrome), and scrolled from top to bottom. At every stop each
// row on screen has its lines drawn inside its own box, with no stretch
// of it left blank. alpha.4 drew the first file and left every other
// row an empty box of the right height: the virtualizer's ref was new
// on each render, and React's call of the old one with null
// disconnected every row.
//
// Run: pnpm test commit-diff-rows.
// covers: app/lab/fake-host/**
// covers: app/renderer/components/diff/**
// covers: packages/ui/src/views/diff/**
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { chromium, type Page } from "playwright-core";
import { it } from "vitest";
import {
  appRoot,
  freeLoopbackPort,
  sandboxGit,
  scrubbedGitEnv,
  scrubProcessGitEnv,
  tempDir,
  waitFor,
} from "./lib/checkKit.mts";
import { engineGit } from "./lib/gitPromises.mts";
import { trackTest } from "./lib/vitestKit.mts";

const gitEnv = scrubbedGitEnv();
scrubProcessGitEnv();
const git = sandboxGit(gitEnv);

// Any worktree of the fake host's: the page reads the diff by hash,
// and the fake host answers every hash with the patch it was handed.
const COMMIT_PAGE =
  "/devices/dev_8f3ac2e1/projects/p_sm/worktrees/a10000000002/commits/";

const cppLines = (count: number, tag: string) =>
  Array.from(
    { length: count },
    (_, i) =>
      `int ${tag}_${i}(int amount) { return amount * ${i} + ${tag.length}; }\n`,
  ).join("");

// A commit shaped like the one alpha.4 drew wrong: a file rewritten
// over more than a screen, then files with a line or two changed and
// one with lines added, in path order.
function seedRepo(): { repo: string; head: string } {
  const repo = tempDir("sm-commit-diff-rows-", trackTest);
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  };
  git(repo, "init", "-q", "-b", "main");
  write("src/systems/shop/shop_system.cpp", cppLines(60, "price"));
  write("src/systems/world/world_system_init.cpp", cppLines(20, "init"));
  write("src/systems/world/world_system_init.hpp", cppLines(12, "decl"));
  write("src/util/board/board.cpp", cppLines(8, "cell"));
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "base");

  write("src/systems/shop/shop_system.cpp", cppLines(59, "cost"));
  write(
    "src/systems/world/world_system_init.cpp",
    cppLines(20, "init").replace("init_9(", "init_nine("),
  );
  write(
    "src/systems/world/world_system_init.hpp",
    cppLines(12, "decl").replace(/int decl_[56]\(.*\n/g, "") +
      "int decl_merged(int amount);\n",
  );
  write("src/util/board/board.cpp", cppLines(8, "cell") + cppLines(16, "row"));
  git(repo, "commit", "-q", "-am", "Rewrite the shop's prices");
  return { repo, head: git(repo, "rev-parse", "HEAD").trim() };
}

// The desktop fake host (app/lab/fake-host), on a port of its own.
async function startFakeHost(): Promise<string> {
  const port = await freeLoopbackPort();
  const server = spawn(
    join(appRoot, "node_modules/.bin/vite"),
    ["--config", "lab/fake-host/vite.config.ts", "--host", "127.0.0.1"],
    {
      cwd: appRoot,
      env: { ...process.env, FAKE_HOST_PORT: String(port) },
      stdio: "ignore",
    },
  );
  trackTest(() => {
    server.kill();
  });
  const url = `http://127.0.0.1:${port}`;
  await waitFor(
    () =>
      fetch(url).then(
        (r) => r.ok,
        () => false,
      ),
    "the fake host's vite server",
    60_000,
  );
  return url;
}

// A cold vite transforms the whole renderer on the first load, which
// takes a CI runner a minute or more, can answer 504 while it bundles
// dependencies, and reloads the page once they're bundled. Only the
// load that opens keeps its errors.
async function openFakeHost(
  page: Page,
  url: string,
  errors: string[],
): Promise<void> {
  const deadline = Date.now() + 180_000;
  for (;;) {
    errors.length = 0;
    try {
      await page.goto(`${url}/?theme=dark`, {
        waitUntil: "commit",
        timeout: 60_000,
      });
      await page.waitForFunction(() => window.fakeHost?.navigate, null, {
        timeout: Math.max(1, deadline - Date.now()),
      });
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
    }
  }
}

type RowFault = { file: string; fault: string };

// What is wrong on screen right now, per row: a row in view with a
// stretch with nothing drawn (more than a line's height), or a line
// drawn outside its row's box.
function faultsInView(page: Page): Promise<RowFault[]> {
  return page.evaluate(() => {
    const LINE = 18;
    const list = document.querySelector('[data-slot="diff-view"]');
    const pane = list?.parentElement?.getBoundingClientRect();
    if (!list || !pane) return [{ file: "", fault: "no diff pane" }];
    const faults: { file: string; fault: string }[] = [];
    for (const row of list.querySelectorAll<HTMLElement>("[data-diff-file]")) {
      const file = row.dataset.diffFile ?? "";
      const box = row.getBoundingClientRect();
      const top = Math.max(box.top, pane.top);
      const bottom = Math.min(box.bottom, pane.bottom);
      if (bottom <= top) continue;
      const drawn = [
        ...(row.firstElementChild?.shadowRoot?.querySelectorAll(
          "[data-diffs-header], [data-line], [data-separator]",
        ) ?? []),
      ].map((el) => el.getBoundingClientRect());
      const outside = drawn.find(
        (line) => line.top < box.top - 1 || line.bottom > box.bottom + 1,
      );
      if (outside) {
        faults.push({
          file,
          fault: `a line at ${Math.round(outside.top - box.top)}px, outside its row's ${Math.round(box.height)}px`,
        });
      }
      // The visible part of the row, less the padding under its last
      // line, has to be covered by what it drew.
      let reached = top;
      for (const line of drawn
        .filter((l) => l.bottom > top && l.top < bottom)
        .toSorted((a, b) => a.top - b.top)) {
        if (line.top - reached > LINE) break;
        reached = Math.max(reached, line.bottom);
      }
      const end = Math.min(bottom, box.bottom - 2 * LINE);
      if (end - reached > LINE) {
        faults.push({
          file,
          fault: `nothing drawn from ${Math.round(reached - box.top)}px to ${Math.round(end - box.top)}px of its ${Math.round(box.height)}px`,
        });
      }
    }
    return faults;
  });
}

it("draws every row of a real commit's diff at every scroll", async () => {
  const { repo, head } = seedRepo();
  const patch = await engineGit.commitDiff(repo, head);
  assert.equal(patch.match(/^diff --git /gm)?.length, 4);
  assert.match(patch, /^index [0-9a-f]{40}\.\.[0-9a-f]{40}/m);

  const [url, browser] = await Promise.all([
    startFakeHost(),
    chromium.launch({ channel: "chrome" }).then((launched) => {
      trackTest(() => launched.close());
      return launched;
    }),
  ]);
  const page = await browser.newPage({
    viewport: { width: 1000, height: 700 },
  });
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));

  await openFakeHost(page, url, errors);
  await page.evaluate(
    ([commitPatch, to]) => {
      window.fakeHost?.setPatch(commitPatch);
      window.fakeHost?.navigate?.(to);
    },
    [patch, `${COMMIT_PAGE}${head}`] as const,
  );
  const rows = page.locator("[data-diff-file]");
  await waitFor(
    async () => (await rows.count()) === 4,
    "the four rows",
    120_000,
  );

  const scroller = page.locator('[data-slot="diff-view"] >> xpath=..');
  const size = () =>
    scroller.evaluate((el) => ({
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    }));
  // Each row takes its height from pierre's metrics once it is laid out.
  await waitFor(
    async () => {
      const { scrollHeight, clientHeight } = await size();
      return scrollHeight > 2 * clientHeight;
    },
    "the patch to run past two screens",
    60_000,
  );
  const { scrollHeight, clientHeight } = await size();
  // Down in steps under a screen, so every part of every row is on
  // screen at some stop, then back to the top.
  const stops = [];
  for (let top = 0; top < scrollHeight; top += clientHeight / 2) {
    stops.push(Math.round(top));
  }
  stops.push(scrollHeight, 0);
  for (const top of stops) {
    await scroller.evaluate((el, scrollTop) => {
      el.scrollTop = scrollTop;
    }, top);
    let faults: RowFault[] = [];
    await waitFor(
      async () => {
        faults = await faultsInView(page);
        return faults.length === 0;
      },
      `every row in view drawn at scrollTop ${top}`,
      // The first stop waits on the highlighter's first load.
      top === 0 ? 60_000 : 5_000,
    ).catch((error: Error) => {
      throw new Error(
        `${error.message}:\n${faults.map((f) => `  ${f.file}: ${f.fault}`).join("\n")}`,
      );
    });
  }

  assert.deepEqual(errors, []);
});
