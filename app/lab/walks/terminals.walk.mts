// A terminal in the packaged build: opened from a worktree's footer,
// typed into, and after the app quits as a person quits it and starts
// again, back in the folder it was left in with what it showed above.
import { afterAll, beforeAll, expect, it } from "vitest";
import { seedDemo } from "./lib/demoRepo.mts";
import { bootLab, type Lab } from "./lib/labApp.mts";
import { openPrimary, terminalText } from "./lib/page.mts";

let lab: Lab;

beforeAll(async () => {
  lab = await bootLab({ seed: seedDemo });
  await openPrimary(lab.page, "demo");
});
afterAll(() => lab?.close());

const screen = async () => (await terminalText(lab.page)) ?? "";

const openTerminal = async () => {
  if (!(await lab.page.locator(".xterm").isVisible())) {
    await lab.page
      .locator("footer")
      .getByText("Terminal", { exact: true })
      .click();
  }
  await lab.page.locator(".xterm").waitFor();
};

it("runs what is typed in the worktree", async () => {
  await openTerminal();
  await lab.page.locator(".xterm").click();
  await lab.page.keyboard.type("cd src && echo marker-$((6*7)) && pwd");
  await lab.page.keyboard.press("Enter");
  await expect.poll(screen).toMatch(/^marker-42$/m);
  await expect.poll(screen).toMatch(/\/repos\/demo\/src$/m);
});

it("comes back after a quit in its folder, with its lines above", async () => {
  await lab.restart();
  // The window comes back on the page it was quit on.
  await lab.page.getByRole("heading", { level: 1, name: "main" }).waitFor();
  await openTerminal();
  // The output, not the command line: how a shell echoes a command
  // depends on its prompt, and a long one wraps it.
  await expect.poll(screen).toMatch(/^marker-42$/m);
  await lab.page.locator(".xterm").click();
  await lab.page.keyboard.type("pwd");
  await lab.page.keyboard.press("Enter");
  await expect
    .poll(async () => (await screen()).match(/\/repos\/demo\/src$/gm)?.length)
    .toBe(2);
});
