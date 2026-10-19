// The Configure page in the packaged build, beside the terminal: a
// setting `smlab projects config` changes while the form holds an
// unsaved edit shows in the form and stays when the form saves (the
// draft takes what it left alone, and its save is a patch of what it
// changed, shigomori:patch).
import { afterAll, beforeAll, expect, it } from "vitest";
import { seedDemo } from "./lib/demoRepo.mts";
import { bootLab, type Lab } from "./lib/labApp.mts";
import { main, openPrimary } from "./lib/page.mts";

let lab: Lab;

beforeAll(async () => {
  lab = await bootLab({ seed: seedDemo });
  await openPrimary(lab.page, "demo");
});
afterAll(() => lab?.close());

const setting = (key: string) =>
  lab.sm("projects", "config", "get", key, "-p", "demo").trim();

it("keeps a setting the terminal changed while the form held an edit", async () => {
  const { page } = lab;
  await page.getByRole("button", { name: "More actions for demo" }).click();
  await page.getByRole("menuitem", { name: "Configure" }).click();
  const form = main(page);
  await form.getByLabel("Setup", { exact: true }).fill("pnpm install");
  lab.sm(
    "projects",
    "config",
    "set",
    "scripts.teardown",
    "make clean",
    "-p",
    "demo",
  );
  await expect
    .poll(() => form.getByLabel("Teardown", { exact: true }).inputValue())
    .toBe("make clean");
  await form.getByRole("button", { name: "Save" }).click();
  await form.getByText("Saved.").waitFor();
  expect(setting("scripts.setup")).toBe("pnpm install");
  expect(setting("scripts.teardown")).toBe("make clean");
});
