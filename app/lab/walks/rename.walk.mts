// Renaming a worktree from its page, in the packaged build: the folder
// moves, and the window stays on the worktree's page under its new
// name.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { seedDemo } from "./lib/demoRepo.mts";
import { bootLab, type Lab } from "./lib/labApp.mts";
import { main, openPrimary, sidebar } from "./lib/page.mts";

let lab: Lab;

beforeAll(async () => {
  lab = await bootLab({ seed: seedDemo });
  lab.sm("create", "before", "-p", "demo", "--no-cd", "--no-setup");
  await openPrimary(lab.page, "demo");
});
afterAll(() => lab?.close());

it("moves the folder and stays on the renamed worktree's page", async () => {
  const { page } = lab;
  await sidebar(page).getByText("before", { exact: true }).first().click();
  await main(page).getByRole("heading", { level: 1, name: "before" }).waitFor();
  await main(page).getByRole("button", { name: "Rename before" }).click();
  const field = main(page).getByRole("textbox").first();
  await field.fill("after");
  await field.press("Enter");
  const moved = join(lab.dataDir, "wt", "demo", "after");
  await expect.poll(() => existsSync(moved)).toBe(true);
  await expect
    .poll(() => main(page).innerText(), { timeout: 10_000 })
    .toMatch(/wt\/demo\/after/);
  await main(page).getByRole("heading", { level: 1, name: "before" }).waitFor();
});
