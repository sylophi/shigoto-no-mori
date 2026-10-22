// Durable proof that a diff page keeps only what is near the view in
// the DOM, however many files it holds (renderer/components/diff), drawn
// by the real renderer (the lab's fake host, in Chrome).
//
// The changes page of a worktree with an unignored build folder, two
// thousand new files, lists a screenful of rows at the top and again at
// the end, where the last file's row is, and its filter finds a row from
// the middle. A row for every file would hold the window for seconds and
// take gigabytes.
//
// A branch of two thousand files mounts a few of its files at its top,
// its middle and its end, and so does a pull request's page of them
// after a jump from its list to a file in the middle, which lands at the
// top of the view, and after a scroll, where the list marks the file
// the view reached. Every file mounted measured where it sat, one forced
// layout after another, before the window could paint.
//
// Run: pnpm test diff-at-scale.
// covers: app/lab/fake-host/**
// covers: app/renderer/components/diff/**
// covers: packages/ui/src/views/diff/**
// covers: packages/ui/src/fixtures/**
import assert from "node:assert/strict";
import { chromium, type Page } from "playwright-core";
import { it } from "vitest";
import { waitFor } from "./lib/checkKit.mts";
import { openFakeHost, startFakeHost } from "./lib/fakeHostPage.mts";
import { trackTest } from "./lib/vitestKit.mts";

const DEVICE = "dev_8f3ac2e1";
const WORKTREE = "happy-hummingbird";
const WORKTREE_PAGE = `/devices/${DEVICE}/projects/p_sm/worktrees/a10000000002`;
// The fixture's eight changed files and a build folder's new ones
// (changesFixtures.ts), the last by path its deleted file.
const FILES = 2000;
const LAST_FILE = "oldStatus.ts";

// A screenful of the list and the rows drawn past either edge, with
// room to spare.
const ROWS_AT_MOST = 100;
// The files of a screen and those drawn past either edge, with room to
// spare.
const FILES_AT_MOST = 40;

// The gap the pane leaves above a file it was asked to show.
const FILE_GAP = 8;

// The branch's patch, two megabytes, so a worker parses it: each file
// six lines changed among six of context.
const branchPath = (i: number) => `src/f${String(i).padStart(5, "0")}.ts`;
const branchPatch = Array.from({ length: FILES }, (_, i) => {
  const path = branchPath(i);
  const line = (n: number, value: number) =>
    `export const value${n} = compute(${value}, "${path}");`;
  const lines = (sign: string, from: number, value: number) =>
    Array.from({ length: 3 }, (_line, n) => `${sign}${line(from + n, value)}`);
  return [
    `diff --git a/${path} b/${path}`,
    "index 1111111..2222222 100644",
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -1,12 +1,12 @@",
    ...lines(" ", 0, 0),
    ...lines("-", 3, i),
    ...lines("-", 6, i),
    ...lines("+", 3, i + 1),
    ...lines("+", 6, i + 1),
    ...lines(" ", 9, 0),
    "",
  ].join("\n");
}).join("");
const MIDDLE_FILE = branchPath(1000);

// What the branch's pane shows: the files mounted, the one at the top
// of the view (the first whose bottom is under it), how far below the
// top that one starts, and the file the index marks.
function paneState(page: Page) {
  return page.evaluate(() => {
    const list = document.querySelector('[data-slot="diff-view"]');
    const pane = list?.parentElement?.getBoundingClientRect();
    const files = [
      ...(list?.querySelectorAll<HTMLElement>("[data-diff-file]") ?? []),
    ].map((file) => ({
      key: file.dataset.diffFile ?? "",
      box: file.getBoundingClientRect(),
    }));
    const top = files
      .filter(({ box }) => pane && box.bottom > pane.top + 1)
      .toSorted((a, b) => a.box.top - b.box.top)[0];
    const marked = document
      .querySelector<HTMLElement>(
        '[data-slot="diff-index-jump"][aria-current="true"]',
      )
      ?.closest<HTMLElement>("[data-row-key]")?.dataset.rowKey;
    return {
      mounted: files.length,
      top: top?.key.trim(),
      topOffset: top && pane ? Math.round(top.box.top - pane.top) : undefined,
      marked: marked?.trim(),
    };
  });
}

// Scrolls the pane to its middle, its end, or on by some pixels.
function scrollPane(page: Page, to: "middle" | "end" | number) {
  return page.locator('[data-slot="diff-view"]').evaluate((list, where) => {
    const pane = list.parentElement;
    if (!pane) return;
    if (typeof where === "number") pane.scrollBy({ top: where });
    else
      pane.scrollTo({
        top: where === "end" ? pane.scrollHeight : pane.scrollHeight / 2,
      });
  }, to);
}

// The waits fit a cold vite on a CI runner, which can run past
// vitest's 5 min.
it(
  "keeps only what is near the view of thousands of files",
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
      [DEVICE, WORKTREE, FILES, `${WORKTREE_PAGE}/diff`] as const,
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

    const filter = page.getByPlaceholder("Filter files");
    await filter.fill("chunk-01000");
    await waitFor(
      async () =>
        (await rows.allInnerTexts()).join(" ").includes("chunk-01000"),
      "the filtered row",
      10_000,
    );
    assert.equal(await rows.count(), 1);

    // The branch, at its top, its middle and its end.
    await page.evaluate(
      ([patch, to]) => {
        window.fakeHost?.setPatch(patch);
        window.fakeHost?.navigate?.(to);
      },
      [branchPatch, `${WORKTREE_PAGE}/branch-diff`] as const,
    );
    for (const [where, reached] of [
      ["top", (top: string) => top === branchPath(0)],
      ["middle", (top: string) => top > branchPath(FILES / 2 - 100)],
      ["end", (top: string) => top > branchPath(FILES - 40)],
    ] as const) {
      if (where === "middle") await scrollPane(page, "middle");
      if (where === "end") await scrollPane(page, "end");
      await waitFor(
        async () => {
          const { top } = await paneState(page);
          return top !== undefined && reached(top);
        },
        `the branch's ${where}`,
        60_000,
      );
      const { mounted } = await paneState(page);
      assert.ok(
        mounted <= FILES_AT_MOST,
        `${mounted} files mounted at the ${where} of ${FILES}`,
      );
    }

    // The pull request's page lists its files beside them: a jump from
    // the list to the middle, then ten screens on through files not yet
    // drawn.
    await page.evaluate(
      (to) => window.fakeHost?.navigate?.(to),
      `${WORKTREE_PAGE}/pr-diff`,
    );
    await waitFor(
      async () => (await paneState(page)).top === branchPath(0),
      "the pull request's first file",
      60_000,
    );
    await filter.fill(MIDDLE_FILE);
    await rows.filter({ hasText: MIDDLE_FILE.split("/")[1] }).click();
    await waitFor(
      async () => {
        const { top, topOffset } = await paneState(page);
        return top === MIDDLE_FILE && topOffset === FILE_GAP;
      },
      `${MIDDLE_FILE} at the top of the view`,
      10_000,
    );
    const jumped = await paneState(page);
    assert.ok(
      jumped.mounted <= FILES_AT_MOST,
      `${jumped.mounted} files mounted after a jump to ${MIDDLE_FILE}`,
    );
    assert.equal(jumped.marked, MIDDLE_FILE);

    await filter.fill("");
    await scrollPane(page, 7000);
    await waitFor(
      async () => {
        const { top, marked } = await paneState(page);
        return top !== undefined && top > MIDDLE_FILE && marked === top;
      },
      "the list marking the file the scroll reached",
      10_000,
    );
    const scrolled = await paneState(page);
    assert.ok(
      scrolled.mounted <= FILES_AT_MOST,
      `${scrolled.mounted} files mounted after a scroll`,
    );

    assert.deepEqual(errors, []);
  },
  10 * 60_000,
);
