// The changes page on real git, in the packaged build: the list, an
// image's two sides, leaving a file out, a hunk's discard and its Undo,
// a commit, and the last-commit strip's undo and amend.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { seedDemo } from "./lib/demoRepo.mts";
import { bootLab, type Lab } from "./lib/labApp.mts";
import { deepText, main, media, openPrimary, sidebar } from "./lib/page.mts";

let lab: Lab;
let repo: string;

beforeAll(async () => {
  lab = await bootLab({
    seed: (dir, git) => {
      repo = seedDemo(dir, git);
    },
  });
  await openPrimary(lab.page, "demo");
});
afterAll(() => lab?.close());

const appTs = () => readFileSync(join(repo, "src/app.ts"), "utf8");

it("lists every kind of change and draws an image's two sides", async () => {
  const { page } = lab;
  await main(page).getByText("4 files changed").click();
  await main(page)
    .getByRole("heading", { name: "Uncommitted changes" })
    .waitFor();
  for (const name of ["NOTES.md", "logo.png", "new-file.txt", "app.ts"]) {
    await sidebar(page).getByText(name, { exact: true }).waitFor();
  }
  await sidebar(page).getByText("logo.png", { exact: true }).click();
  await expect.poll(() => media(page)).toMatchObject({ images: 2, broken: 0 });
});

it("leaves a file out of the commit", async () => {
  const { page } = lab;
  await page
    .getByRole("checkbox", { name: "Leave new-file.txt out of the commit" })
    .click();
  await page.getByRole("button", { name: "Commit 3 files" }).waitFor();
});

it("discards a hunk, and Undo puts it back", async () => {
  const { page } = lab;
  await sidebar(page).getByText("app.ts", { exact: true }).click();
  await expect.poll(() => deepText(page)).toContain("hey");
  await main(page)
    .getByRole("button", { name: "Discard", exact: true })
    .click();
  await expect.poll(appTs).toContain("`hello ${n}`");
  await page.getByRole("button", { name: "Undo" }).click();
  await expect.poll(appTs).toContain("`hey ${n}`");
});

it("commits what is ticked, with its message", async () => {
  const { page } = lab;
  await page.getByLabel("Commit summary").fill("Commit from a walk");
  await page.getByLabel("Commit description").fill("Its body");
  await page.getByRole("button", { name: "Commit 3 files" }).click();
  await expect
    .poll(() => lab.git(repo, "log", "-1", "--format=%s%n%b").trim())
    .toBe("Commit from a walk\nIts body");
  assert.deepEqual(
    lab
      .git(repo, "show", "--name-only", "--format=", "HEAD")
      .trim()
      .split("\n")
      .toSorted(),
    ["NOTES.md", "media/logo.png", "src/app.ts"],
  );
  assert.equal(lab.git(repo, "status", "--short").trim(), "?? new-file.txt");
});

it("undoes the last commit from its strip, keeping the changes", async () => {
  const { page } = lab;
  await page.getByRole("button", { name: "Undo the last commit" }).click();
  await expect
    .poll(() => lab.git(repo, "log", "-1", "--format=%s").trim())
    .toBe("Touch several files");
  await expect
    .poll(
      () =>
        lab.git(repo, "status", "--short").split("\n").filter(Boolean).length,
    )
    .toBe(4);
});

it("amends the last commit's message from its strip", async () => {
  const { page } = lab;
  await page.getByLabel("Commit summary").fill("Recommit");
  await page.getByRole("button", { name: "Commit 3 files" }).click();
  await expect
    .poll(() => lab.git(repo, "log", "-1", "--format=%s").trim())
    .toBe("Recommit");
  const before = lab.git(repo, "rev-list", "--count", "HEAD").trim();
  await page.getByRole("button", { name: "Amend the last commit" }).click();
  // Amend mode fills the summary with the commit's message once it has
  // read it, so the new message goes in after that.
  const summary = page.getByLabel("Commit summary");
  await expect.poll(() => summary.inputValue()).toBe("Recommit");
  await summary.fill("Recommit, amended");
  await expect.poll(() => summary.inputValue()).toBe("Recommit, amended");
  await page.getByRole("button", { name: "Amend the message" }).click();
  await expect
    .poll(() => lab.git(repo, "log", "-1", "--format=%s").trim())
    .toBe("Recommit, amended");
  assert.equal(lab.git(repo, "rev-list", "--count", "HEAD").trim(), before);
});
