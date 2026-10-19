// What a window shows of another device when that device stops
// answering or stops taking commands from here: a device tab switched
// to one never reached, a terminal open when control is turned off,
// and a mirror whose runner quits. Each is what was on screen before,
// kept or replaced by the words for it, never the last device's or a
// dead one.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import {
  mirror,
  openMirroredPair,
  openPeerWorktree,
  quickCreate,
  setControl,
} from "./lib/crossDevice.mts";
import { type Devices, startDevices } from "./lib/devices.mts";
import type { Lab } from "./lib/labApp.mts";
import { main, sidebar, terminalText } from "./lib/page.mts";
import {
  REAL_NAME,
  type RealOrigin,
  seedRealProject,
  startRealOrigin,
} from "./lib/realRepo.mts";

let origin: RealOrigin;
let devices: Devices;
// A runs the mirror and is driven from B; both have the project.
let a: Lab;
let b: Lab;

// A folder only A's home has, which a listing under any other device
// must not show.
const ONLY_ON_A = "only-on-a";

beforeAll(async () => {
  origin = await startRealOrigin();
  devices = await startDevices();
  a = await devices.add("a", (reposDir, git, home) => {
    seedRealProject(reposDir, git, home, origin);
    mkdirSync(join(home, ONLY_ON_A));
  });
  b = await devices.add("b", (reposDir, git, home) => {
    seedRealProject(reposDir, git, home, origin);
  });
  for (const lab of [a, b]) lab.sm("config", "set", "doubutsuNames", "true");
}, 5 * 60_000);
// A walk that failed may leave its menu or dialog open over the next
// one's clicks.
afterEach(async () => {
  for (const lab of [a, b]) {
    // A quits for good in the last walk.
    if (lab === undefined || lab.page.isClosed()) continue;
    const open = lab.page.locator('[role="dialog"], [role="menu"]');
    for (let tries = 0; tries < 6 && (await open.count()) > 0; tries += 1) {
      await lab.page.keyboard.press("Escape");
    }
  }
});
afterAll(async () => {
  try {
    await devices?.close();
  } finally {
    await origin?.stop();
  }
});

const TERMINALS_HIDDEN_A =
  /Terminals stay hidden until .*\[walk-a\] turns on .Allow control from other devices./;

// Types into the terminal on screen and waits for what it answers.
const answers = async (page: Page, marker: string) => {
  await page.locator(".xterm").click();
  await page.keyboard.type(`echo ${marker}-$((6*7))`);
  await page.keyboard.press("Enter");
  await expect
    .poll(async () => (await terminalText(page)) ?? "", { timeout: 30_000 })
    .toContain(`${marker}-42`);
};

it("a device tab switched to one never reached here says it is offline, and lists nothing of the last device", async () => {
  await setControl(a.page, true);
  // C is on the account and offline, and never reached by B's window:
  // gone before that window started.
  const c = await devices.add("c", () => {});
  await devices.remove(c);
  await b.page.reload();
  await sidebar(b.page).getByRole("button", { name: "Add project" }).click();
  const dialog = b.page.getByRole("dialog", { name: "Add project" });
  const tab = (device: string) =>
    dialog.getByRole("tab", { name: new RegExp(`\\[walk-${device}\\]`) });
  await tab("a").click();
  await dialog.getByText(ONLY_ON_A, { exact: true }).waitFor();
  expect(await dialog.getByPlaceholder("Folder path").count()).toBe(1);
  await tab("c").click();
  await dialog
    .getByText(/is offline, and its folder listing loads when it reconnects/)
    .waitFor();
  // The note alone: no form under it, so nothing to send anywhere, and
  // nothing of A's drawn in a while.
  await expect
    .poll(() => dialog.getByPlaceholder("Folder path").count())
    .toBe(0);
  const drawn = Date.now();
  while (Date.now() - drawn < 2_000) {
    expect(await dialog.getByText(ONLY_ON_A, { exact: true }).count()).toBe(0);
    await new Promise((done) => setTimeout(done, 200));
  }
  await b.page.keyboard.press("Escape");
});

// The terminal on screen ends when A turns control off, the words for
// it in its place, and a new one answers once control is back.
const revokeAndRegrant = async () => {
  await setControl(a.page, false);
  await main(b.page).getByText(TERMINALS_HIDDEN_A).waitFor();
  await expect.poll(() => b.page.locator(".xterm").count()).toBe(0);
  await setControl(a.page, true);
  await answers(b.page, "again");
};

it("the other device's own terminal gives way to the read-only words when its control goes off, and comes back with it", async () => {
  await setControl(a.page, true);
  await b.page.keyboard.press("Meta+K");
  await b.page.keyboard.type("Terminals on");
  await b.page
    .getByRole("option", { name: /Terminals on .*\[walk-a\]/ })
    .click();
  await answers(b.page, "device");
  await revokeAndRegrant();
});

it("a worktree's terminal drawer on the other device does the same", async () => {
  await setControl(a.page, true);
  const name = await quickCreate(a, join(a.root, "repos", REAL_NAME));
  await openPeerWorktree(b.page, "a", name);
  await b.page.locator("footer").getByText("Terminal", { exact: true }).click();
  await answers(b.page, "drawer");
  await revokeAndRegrant();
});

// Last: A quits for good.
it("a mirror whose runner quits stays on the copy's page, its control saying so, and offers nothing that assumes it gone", async () => {
  await setControl(b.page, true);
  const name = await quickCreate(a, join(a.root, "repos", REAL_NAME));
  await mirror(a, "b");
  await openMirroredPair(b.page, name);
  const mirroring = main(b.page).getByRole("button", { name: "Mirroring" });
  const live = sidebar(b.page).getByRole("button", {
    name: "Live (1 running)",
  });
  await mirroring.waitFor();
  await live.waitFor();

  await devices.remove(a);
  await expect
    .poll(() => mirroring.isDisabled(), { timeout: 60_000 })
    .toBe(true);
  // Held, past B's own served stream closing on A's dead socket, which
  // alone kept the pair a moment longer.
  const away = Date.now();
  while (Date.now() - away < 8_000) {
    expect(await mirroring.isDisabled()).toBe(true);
    expect(await live.count()).toBe(1);
    await new Promise((done) => setTimeout(done, 250));
  }
  await main(b.page).getByRole("button", { name: "Options" }).click();
  await b.page.getByText("Auto-pull", { exact: true }).waitFor();
  expect(await b.page.getByText("Transplant", { exact: true }).count()).toBe(0);
  await b.page.keyboard.press("Escape");
});
