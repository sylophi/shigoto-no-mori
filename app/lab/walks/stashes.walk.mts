// Stashes on real git, in the packaged build: the list, a stash's
// diff, stashing, a drop and its Undo, and a restore that keeps it.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { seedDemo } from "./lib/demoRepo.mts";
import { bootLab, type Lab } from "./lib/labApp.mts";
import { deepText, main, openPrimary, sidebar } from "./lib/page.mts";

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

const stashes = () =>
  lab.git(repo, "stash", "list", "--format=%gs").split("\n").filter(Boolean);

it("lists the stashes and draws one's diff", async () => {
  const { page } = lab;
  await main(page).getByText("WIP on readme").click();
  await main(page).getByRole("heading", { name: "WIP on readme" }).waitFor();
  await expect.poll(() => deepText(page)).toContain("stashed change");
});

it("stashes the changes under a name", async () => {
  const { page } = lab;
  await page.getByPlaceholder("Name (optional)").fill("walk stash");
  await page.getByRole("button", { name: "Stash", exact: true }).click();
  await expect
    .poll(stashes)
    .toEqual(["On main: walk stash", "On main: WIP on readme"]);
  await expect.poll(() => lab.git(repo, "status", "--short").trim()).toBe("");
});

it("drops a stash, and Undo brings it back", async () => {
  const { page } = lab;
  await sidebar(page).getByText("walk stash").click();
  await main(page).getByRole("button", { name: "Drop", exact: true }).click();
  await expect.poll(stashes).toEqual(["On main: WIP on readme"]);
  await page.getByRole("button", { name: "Undo" }).click();
  await expect.poll(() => stashes().length).toBe(2);
});

it("restores a stash and keeps it", async () => {
  const { page } = lab;
  await sidebar(page).getByText("WIP on readme").click();
  await main(page).getByRole("heading", { name: "WIP on readme" }).waitFor();
  await main(page).getByRole("button", { name: "Restore and keep it" }).click();
  await expect
    .poll(() => readFileSync(join(repo, "README.md"), "utf8"))
    .toContain("stashed change");
  expect(stashes().length).toBe(2);
});
