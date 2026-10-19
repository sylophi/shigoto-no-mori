// What a person does across devices in the walks: turning control on,
// a quick-created worktree, another device's worktree opened from the
// sidebar, and the mirror and transplant dialogs to their end.
import type { Locator, Page } from "playwright-core";
import { expect } from "vitest";
import type { Lab } from "./labApp.mts";
import { main, sidebar } from "./page.mts";
import { REAL_NAME } from "./realRepo.mts";

export const setControl = async (page: Page, on: boolean) => {
  await sidebar(page).getByRole("button", { name: "Settings" }).click();
  await sidebar(page).getByRole("button", { name: "Account" }).click();
  const control = main(page).getByRole("switch", {
    name: "Allow control from other devices",
  });
  if ((await control.isChecked()) !== on) await control.click();
  await expect.poll(() => control.isChecked()).toBe(on);
  await sidebar(page).getByRole("button", { name: "Back" }).click();
};

// A worktree made as the owner makes one: quick create, off origin/main,
// in the project at `project` on `lab`. Answers its name, the page's
// heading.
export const quickCreate = async (
  lab: Lab,
  project: string,
): Promise<string> => {
  await sidebar(lab.page)
    .getByRole("radio", { name: /This device/ })
    .click();
  const heading = main(lab.page).getByRole("heading", { level: 1 });
  const before = await heading.textContent();
  // Whether the new worktree's page ever shows the newest commit of the
  // branch it came from, which isn't one of its own.
  const tip = lab
    .git(project, "log", "-1", "--format=%s", "origin/main")
    .trim();
  await lab.page.evaluate(`(() => {
    const was = ${JSON.stringify(before ?? "")};
    const subject = ${JSON.stringify(tip)};
    window.smWalkBaseTipWatch?.disconnect();
    window.smWalkSawBaseTip = false;
    window.smWalkBaseTipWatch = new MutationObserver(() => {
      const page = document.querySelector("main");
      const title = page?.querySelector("h1")?.textContent;
      if (title !== was && title !== "Projects" && page?.textContent?.includes(subject)) {
        window.smWalkSawBaseTip = true;
      }
    });
    window.smWalkBaseTipWatch.observe(document.body, { subtree: true, childList: true, characterData: true });
  })()`);
  await sidebar(lab.page)
    .getByRole("button", { name: `Quick-create worktree in ${REAL_NAME}` })
    .first()
    .click();
  await expect
    .poll(() => heading.textContent(), { timeout: 30_000 })
    .not.toMatch(new RegExp(`^(Projects|${before ?? ""})$`));
  const name = (await heading.textContent()) ?? "";
  await main(lab.page).getByText("No uncommitted changes").waitFor();
  // History's first answer is eight git runs queued for the host's
  // spawn slots, slow on a CI runner beside two more apps (V3.md).
  await main(lab.page).getByText("No commits yet").waitFor({ timeout: 30_000 });
  const sawBaseTip = await lab.page.evaluate(
    "window.smWalkBaseTipWatch.disconnect(), window.smWalkSawBaseTip",
  );
  expect(
    sawBaseTip,
    "a new worktree's History showed its base's newest commit",
  ).toBe(false);
  return name;
};

// A worktree's row, under the device the sidebar's radio `device`
// names, opened from the sidebar.
const openWorktree = async (
  page: Page,
  device: RegExp,
  row: RegExp,
  name: string,
) => {
  await sidebar(page).getByRole("radio", { name: device }).click();
  const project = sidebar(page).getByRole("button", {
    name: REAL_NAME,
    exact: true,
  });
  if (
    (await project.isVisible()) &&
    (await project.getAttribute("aria-expanded")) !== "true"
  ) {
    await project.click();
  }
  await sidebar(page).getByRole("button", { name: row }).click();
  await main(page)
    .getByRole("heading", { level: 1, name, exact: true })
    .waitFor();
};

// The other device's worktree, opened from this one's sidebar.
export const openPeerWorktree = (page: Page, device: string, name: string) =>
  openWorktree(
    page,
    new RegExp(`\\[walk-${device}\\]`),
    new RegExp(`^${name} ${name} On `),
    name,
  );

// This device's own worktree, opened from its sidebar.
export const openOwnWorktree = (page: Page, name: string) =>
  openWorktree(page, /This device/, new RegExp(`^${name} ${name}`), name);

// A mirrored pair's one row, under every device: the filter for one
// device doesn't show a pair that another device runs.
export const openMirroredPair = (page: Page, name: string) =>
  openWorktree(page, /Every device/, new RegExp(`^${name} ${name}`), name);

// A destructive button's two clicks, as quick as a person's: once armed
// the button moves, and Playwright's wait for it to settle outlasts the
// arm.
export const confirmTwice = (button: Locator) =>
  button.evaluate((element: HTMLElement) => {
    element.click();
    element.click();
  });

// The dialog picks the one device it can go to by itself, and draws
// again as it learns the devices: the menu is opened until it shows.
export const pickDevice = async (
  page: Page,
  dialog: Locator,
  device: string,
) => {
  const named = new RegExp(`\\[walk-${device}\\]`);
  const button = dialog.getByRole("button", { name: "Destination device" });
  const item = page.getByRole("menuitemradio", { name: named });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (named.test((await button.textContent()) ?? "")) return;
    await button.click({ timeout: 2_000 }).catch(() => {});
    const shown = await item
      .waitFor({ timeout: 1_000 })
      .then(() => true)
      .catch(() => false);
    if (shown) break;
  }
  if (!named.test((await button.textContent()) ?? "")) await item.click();
  await expect
    .poll(async () => (await button.textContent()) ?? "")
    .toMatch(named);
};

// The dialog's end: its success heading, or its failure's, which fails
// the walk with what the dialog says (the error the person reads).
export const settle = async (page: Page, success: string, failure: string) => {
  const ended = page.getByRole("heading", {
    name: new RegExp(`^(${success}|${failure})$`),
  });
  await ended.waitFor({ timeout: 120_000 });
  if ((await ended.textContent()) === failure) {
    const said = await page.getByRole("dialog").last().innerText();
    throw new Error(
      `${failure}: ${said.split("\n").filter(Boolean).join(" | ")}`,
    );
  }
};

// Mirror from the worktree's own page, to `device`, or from a peer's
// page, here.
export const mirror = async (lab: Lab, device?: string) => {
  await main(lab.page)
    .getByRole("button", { name: "Mirror", exact: true })
    .click();
  const dialog = lab.page.getByRole("dialog", { name: "Mirror worktree" });
  if (device !== undefined) await pickDevice(lab.page, dialog, device);
  await dialog.getByRole("button", { name: "Start mirroring" }).click();
  await settle(lab.page, "Mirror live", "Mirror didn't start");
  await lab.page.keyboard.press("Escape");
};

// Transplant from the worktree's own page, to `device`, or from a peer's
// page, here, tearing the source down at the end.
export const transplant = async (lab: Lab, device?: string) => {
  await main(lab.page).getByRole("button", { name: "Options" }).click();
  await lab.page.getByText("Transplant", { exact: true }).click();
  const dialog = lab.page.getByRole("dialog", { name: "Transplant worktree" });
  await dialog.getByRole("radiogroup", { name: "What to leave out" }).waitFor();
  if (device !== undefined) await pickDevice(lab.page, dialog, device);
  await dialog.getByRole("button", { name: "Start transplant" }).click();
  await settle(lab.page, "Transplant complete", "Transplant stopped");
  const done = lab.page.getByRole("dialog", { name: "Transplant complete" });
  await confirmTwice(
    done.getByRole("button", { name: "Tear down and finish" }),
  );
  await done.waitFor({ state: "hidden", timeout: 60_000 });
};
