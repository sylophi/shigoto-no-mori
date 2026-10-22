// Durable proof that a diff page keeps only what is near the view in
// the DOM, however many files it holds (renderer/components/diff), drawn
// by the real renderer (the lab's fake host, in Chrome). The changes
// page of a worktree with an unignored build folder, two thousand new
// files, lists a screenful of rows at the top and again at the end,
// where the last file's row is, and its filter finds a row from the
// middle. A row for every file held the window for seconds and took
// gigabytes.
//
// Run: pnpm test diff-at-scale.
// covers: app/lab/fake-host/**
// covers: app/renderer/components/diff/**
// covers: packages/ui/src/views/diff/**
// covers: packages/ui/src/fixtures/**
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { it } from "vitest";
import { waitFor } from "./lib/checkKit.mts";
import { openFakeHost, startFakeHost } from "./lib/fakeHostPage.mts";
import { trackTest } from "./lib/vitestKit.mts";

const DEVICE = "dev_8f3ac2e1";
const WORKTREE = "happy-hummingbird";
const CHANGES_PAGE = `/devices/${DEVICE}/projects/p_sm/worktrees/a10000000002/diff`;
// The fixture's eight changed files and a build folder's new ones
// (changesFixtures.ts), the last by path its deleted file.
const FILES = 2000;
const LAST_FILE = "oldStatus.ts";

// A screenful of the list and the rows drawn past either edge, with
// room to spare.
const ROWS_AT_MOST = 100;

// The waits fit a cold vite on a CI runner, which can run past
// vitest's 5 min.
it(
  "lists only the rows near the view of thousands of changed files",
  async () => {
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
      // A cold vite bundles a dependency it meets late (a grammar the
      // highlighter loads) and answers the requests it raced with 504.
      if (m.type() === "error" && !m.text().includes("Outdated Optimize Dep"))
        errors.push(m.text());
    });
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) errors.length = 0;
    });

    await openFakeHost(page, url);
    await page.evaluate(
      ([device, worktree, count, to]) => {
        window.fakeHost?.worktree(device, "update", worktree, {
          changedCount: count,
        });
        window.fakeHost?.navigate?.(to);
      },
      [DEVICE, WORKTREE, FILES, CHANGES_PAGE] as const,
    );
    const rows = page.locator('[data-slot="diff-index-row"]');
    await waitFor(
      async () => (await rows.count()) > 0,
      "the file list",
      120_000,
    );
    const atTop = await rows.count();
    assert.ok(
      atTop <= ROWS_AT_MOST,
      `${atTop} rows in the DOM at the top of ${FILES}`,
    );

    await rows.first().evaluate((row) => {
      let list = row.parentElement;
      while (list && list.scrollHeight <= list.clientHeight)
        list = list.parentElement;
      list?.scrollTo({ top: list.scrollHeight });
    });
    await waitFor(
      async () => (await rows.filter({ hasText: LAST_FILE }).count()) === 1,
      "the last file's row",
      10_000,
    );
    const atEnd = await rows.count();
    assert.ok(
      atEnd <= ROWS_AT_MOST,
      `${atEnd} rows in the DOM at the end of ${FILES}`,
    );

    await page.getByPlaceholder("Filter files").fill("chunk-01000");
    await waitFor(
      async () =>
        (await rows.allInnerTexts()).join(" ").includes("chunk-01000"),
      "the filtered row",
      10_000,
    );
    assert.equal(await rows.count(), 1);

    assert.deepEqual(errors, []);
  },
  10 * 60_000,
);
