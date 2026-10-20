// The new worktree page on real git, in the packaged build: a branch
// off a source, a source branch checked out as it is, and a worktree
// made again under a torn-down one's name.
import assert from "node:assert/strict";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { seedDemo } from "./lib/demoRepo.mts";
import { bootLab, type Lab } from "./lib/labApp.mts";
import { main, openPrimary, sidebar } from "./lib/page.mts";

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

// The branches the repo's worktrees have checked out.
const checkedOut = () =>
  lab
    .git(repo, "worktree", "list", "--porcelain")
    .split("\n")
    .flatMap((line) => /^branch refs\/heads\/(.*)$/.exec(line)?.[1] ?? []);

const openNewWorktree = async () => {
  const { page } = lab;
  await page
    .getByRole("button", { name: "More actions for demo" })
    .first()
    .click();
  await page.getByRole("menuitem", { name: "New worktree from…" }).click();
  await main(page).getByRole("heading", { name: "New worktree" }).waitFor();
};

it("branches off a source under the name typed", async () => {
  const { page } = lab;
  await openNewWorktree();
  await main(page)
    .getByLabel("Branch name", { exact: true })
    .fill("walk-branch");
  await main(page).getByRole("button", { name: "Create worktree" }).click();
  await main(page)
    .getByRole("heading", { level: 1, name: "walk-branch", exact: true })
    .waitFor();
  await expect.poll(checkedOut).toContain("walk-branch");
  assert.equal(
    lab.git(repo, "rev-parse", "walk-branch").trim(),
    lab.git(repo, "rev-parse", "origin/main").trim(),
  );
  // Unpublished, under git's own defaults: no upstream on origin/main.
  assert.throws(() => lab.git(repo, "config", "branch.walk-branch.merge"));
});

it("checks out the source branch itself", async () => {
  const { page } = lab;
  await openNewWorktree();
  await main(page).getByText("Check out source", { exact: true }).click();
  await main(page).getByRole("combobox", { name: "Source" }).click();
  await page.getByRole("option", { name: "feature/one" }).click();
  await main(page).getByRole("button", { name: "Create worktree" }).click();
  await main(page)
    .getByRole("heading", { level: 1, name: "feature/one" })
    .waitFor();
  await expect.poll(checkedOut).toContain("feature/one");
});

// The same name is the same path, so the same id: torn down from its
// page and made again at once, the worktree's page draws the new one's
// changes and history, and never what the window held of the old one's.
it("draws a worktree made again under a torn-down one's name afresh", async () => {
  const { page } = lab;
  const path = join(lab.dataDir, "wt", "demo", "reused");
  lab.sm("create", "reused", "-p", "demo", "--no-cd", "--no-setup");
  writeFileSync(join(path, "old-history.txt"), "old\n");
  lab.git(path, "add", "old-history.txt");
  lab.git(path, "commit", "-q", "-m", "Old reused history");
  appendFileSync(join(path, "old-history.txt"), "uncommitted\n");
  const old = ["Old reused history", "old-history.txt"];
  await sidebar(page).getByText("reused", { exact: true }).first().click();
  for (const text of old) await main(page).getByText(text).first().waitFor();

  await main(page).getByRole("button", { name: "Delete worktree" }).click();
  await main(page).getByRole("button", { name: "Confirm delete?" }).click();
  await main(page).getByRole("button", { name: "Force delete" }).click();
  await expect.poll(() => existsSync(path)).toBe(false);
  await main(page)
    .getByRole("heading", { level: 1, name: "reused" })
    .waitFor({ state: "detached" });

  // Everything the window draws from here on.
  await page.evaluate((markers) => {
    const seen: string[] = [];
    Reflect.set(globalThis, "staleSeen", seen);
    new MutationObserver(() => {
      const text = document.body.innerText;
      for (const marker of markers) {
        if (text.includes(marker) && !seen.includes(marker)) seen.push(marker);
      }
    }).observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
    });
  }, old);
  await openNewWorktree();
  await main(page).getByLabel("Branch name", { exact: true }).fill("reused");
  await main(page).getByRole("button", { name: "Create worktree" }).click();
  await main(page)
    .getByRole("heading", { level: 1, name: "reused", exact: true })
    .waitFor();
  await expect.poll(() => main(page).innerText()).toContain("No commits yet");
  assert.deepEqual(
    await page.evaluate(() => Reflect.get(globalThis, "staleSeen")),
    [],
  );
});
