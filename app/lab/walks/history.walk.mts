// History on real git, in the packaged build: a commit's page with its
// media playing and a long file drawn to its end, a branch's changes,
// and the timeline's squash, hard reset and merge.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { afterAll, beforeAll, expect, it } from "vitest";
import { LONG_LINES, seedDemo } from "./lib/demoRepo.mts";
import { bootLab, type Lab } from "./lib/labApp.mts";
import { deepText, main, media, openPrimary, sidebar } from "./lib/page.mts";

let lab: Lab;
let repo: string;

beforeAll(async () => {
  lab = await bootLab({
    seed: (dir, git) => {
      repo = seedDemo(dir, git);
      git(repo, "stash", "push", "-q", "-u", "-m", "park");
      for (const name of ["one", "two"]) {
        writeFileSync(join(repo, `${name}.txt`), `${name}\n`);
        git(repo, "add", `${name}.txt`);
        git(repo, "commit", "-q", "-m", `Local ${name}`);
      }
    },
  });
  lab.sm(
    "create",
    "featwt",
    "-p",
    "demo",
    "--base",
    "feature/one",
    "--no-cd",
    "--no-setup",
  );
  await openPrimary(lab.page, "demo");
});
afterAll(() => lab?.close());

const head = () => lab.git(repo, "rev-parse", "HEAD").trim();

// Scrolls the diff from top to bottom, gathering what it drew on the way.
async function scrollDiff(page: Page) {
  const seen = { text: "", videos: 0, audios: 0, images: 0, broken: 0 };
  await main(page).hover();
  for (let i = 0; i < 40; i++) {
    const now = await media(page);
    seen.images = Math.max(seen.images, now.images);
    seen.videos = Math.max(seen.videos, now.videos);
    seen.audios = Math.max(seen.audios, now.audios);
    seen.broken += now.broken;
    seen.text += `\n${await deepText(page)}`;
    await page.mouse.wheel(0, 1500);
    await page.waitForTimeout(60);
  }
  return seen;
}

it("draws a commit's image, video and audio", async () => {
  const { page } = lab;
  await main(page).getByText("Local two").click();
  await sidebar(page)
    .getByText("Recolor the logo, add a tone and a clip")
    .click();
  await main(page)
    .getByRole("heading", { name: "Recolor the logo, add a tone and a clip" })
    .waitFor();
  const seen = await scrollDiff(page);
  assert.deepEqual(
    {
      images: seen.images,
      videos: seen.videos,
      audios: seen.audios,
      broken: seen.broken,
    },
    { images: 2, videos: 1, audios: 1, broken: 0 },
  );
});

it("draws a long file's commit to its last line", async () => {
  const { page } = lab;
  await sidebar(page).getByText("Add a long file").click();
  await main(page).getByRole("heading", { name: "Add a long file" }).waitFor();
  const seen = await scrollDiff(page);
  assert.ok(seen.text.includes(`line ${LONG_LINES}`), "the last line drew");
});

it("shows a branch's changes against its base", async () => {
  const { page } = lab;
  await sidebar(page).getByText("main", { exact: true }).first().click();
  await sidebar(page).getByText("featwt", { exact: true }).first().click();
  await main(page).getByText("All branch changes").click();
  await expect.poll(() => deepText(page)).toContain("feature.txt");
});

it("squashes a commit into the one below", async () => {
  const { page } = lab;
  await sidebar(page).getByText("featwt", { exact: true }).first().click();
  await sidebar(page).getByText("main", { exact: true }).first().click();
  await main(page).getByText("Local two").click();
  await sidebar(page).getByText("Local two").click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "Squash into the commit below" })
    .click();
  await expect
    .poll(() => lab.git(repo, "log", "-1", "--format=%B").trim())
    .toBe("Local one\n\nLocal two");
  assert.equal(
    lab.git(repo, "rev-list", "--count", "origin/main..HEAD").trim(),
    "1",
  );
});

it("hard resets to a commit from the timeline", async () => {
  const { page } = lab;
  const target = lab.git(repo, "rev-parse", "origin/main").trim();
  await sidebar(page)
    .getByText("Touch several files")
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "Hard reset to here…" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Hard reset" })
    .click();
  await expect.poll(head).toBe(target);
});

it("merges a branch in from the merge dialog", async () => {
  const { page } = lab;
  const feature = lab.git(repo, "rev-parse", "feature/one").trim();
  await sidebar(page).getByText("Branch", { exact: true }).click();
  await page.getByRole("menuitem", { name: "Merge…" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByText("Select a branch…").click();
  await page.getByRole("option", { name: "feature/one" }).click();
  await dialog.getByRole("button", { name: "Fast-forward" }).last().click();
  await expect.poll(head).toBe(feature);
});
