// The new worktree page on real git, in the packaged build: a branch
// off a source, and a source branch checked out as it is.
import assert from "node:assert/strict";
import { afterAll, beforeAll, expect, it } from "vitest";
import { seedDemo } from "./lib/demoRepo.mts";
import { bootLab, type Lab } from "./lib/labApp.mts";
import { main, openPrimary } from "./lib/page.mts";

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

// Each worktree's branch, by the folder's name.
const worktrees = () =>
  Object.fromEntries(
    lab
      .git(repo, "worktree", "list", "--porcelain")
      .split("\n\n")
      .filter(Boolean)
      .map((entry) => {
        const path = /^worktree (.*)$/m.exec(entry)?.[1] ?? "";
        const branch = /^branch refs\/heads\/(.*)$/m.exec(entry)?.[1] ?? "";
        return [path.split("/").at(-1) ?? "", branch];
      }),
  );

const openNewWorktree = async () => {
  const { page } = lab;
  await page.getByRole("button", { name: "More actions for demo" }).click();
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
    .getByRole("heading", { level: 1, name: "walk-branch" })
    .waitFor();
  assert.equal(worktrees()["walk-branch"], "walk-branch");
  assert.equal(
    lab.git(repo, "rev-parse", "walk-branch").trim(),
    lab.git(repo, "rev-parse", "origin/main").trim(),
  );
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
  await expect.poll(() => worktrees()["feature-one"]).toBe("feature/one");
});
