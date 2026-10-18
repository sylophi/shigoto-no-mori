// Devices of one account (lib/devices.mts) on a real project
// (lib/realRepo.mts) with the owner's settings: browsing the other
// device with its control off and on, and sending, bringing and
// mirroring to and from it, each with the project already there at
// another path and with it missing (cloned first), each started from
// the window a person would start it in. The windows are checked for
// what they say and the disks for what git did.
import { join } from "node:path";
import type { Locator, Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { type Devices, startDevices } from "./lib/devices.mts";
import type { Lab } from "./lib/labApp.mts";
import { main, sidebar } from "./lib/page.mts";
import {
  applyOwnerSettings,
  CARRIED,
  REAL_NAME,
  type RealOrigin,
  seedRealProject,
  startRealOrigin,
  writeUserExcludes,
} from "./lib/realRepo.mts";

let origin: RealOrigin;
let devices: Devices;
// A holds the project; B starts without it and gets it from the first
// clone; each later "missing" case gets a device of its own.
let a: Lab;
let b: Lab;

const blank = (_reposDir: string, _git: Lab["git"], home: string) =>
  writeUserExcludes(home);

beforeAll(async () => {
  origin = await startRealOrigin();
  devices = await startDevices();
  a = await devices.add("a", (reposDir, git, home) => {
    seedRealProject(reposDir, git, home, origin);
  });
  applyOwnerSettings(a);
  b = await devices.add("b", blank);
  for (const lab of [a, b]) lab.sm("config", "set", "doubutsuNames", "true");
}, 5 * 60_000);
// A walk that failed may leave its dialog open over the next one's
// clicks.
afterEach(async () => {
  for (const lab of [a, b]) {
    if (lab === undefined) continue;
    const dialogs = lab.page.getByRole("dialog");
    for (let open = await dialogs.count(); open > 0; open -= 1) {
      await lab.page.keyboard.press("Escape");
      await dialogs
        .nth(open - 1)
        .waitFor({ state: "detached", timeout: 5_000 });
    }
  }
});
afterAll(async () => {
  await devices?.close();
  await origin?.stop();
});

// ---- What a person does.

const setControl = async (page: Page, on: boolean) => {
  await sidebar(page).getByRole("button", { name: "Settings" }).click();
  await sidebar(page).getByRole("button", { name: "Account" }).click();
  const control = main(page).getByRole("switch", {
    name: "Allow control from other devices",
  });
  if ((await control.isChecked()) !== on) await control.click();
  await expect.poll(() => control.isChecked()).toBe(on);
  await sidebar(page).getByRole("button", { name: "Back" }).click();
};

// A worktree made as the owner makes one: quick create, off origin/main.
// Answers its name, the page's heading.
const quickCreate = async (lab: Lab): Promise<string> => {
  await sidebar(lab.page)
    .getByRole("radio", { name: /This device/ })
    .click();
  const heading = main(lab.page).getByRole("heading", { level: 1 });
  const before = await heading.textContent();
  await sidebar(lab.page)
    .getByRole("button", { name: `Quick-create worktree in ${REAL_NAME}` })
    .first()
    .click();
  await expect
    .poll(() => heading.textContent(), { timeout: 30_000 })
    .not.toMatch(new RegExp(`^(Projects|${before ?? ""})$`));
  const name = (await heading.textContent()) ?? "";
  await main(lab.page).getByText("No uncommitted changes").waitFor();
  return name;
};

// The other device's worktree, opened from this one's sidebar.
const openPeerWorktree = async (page: Page, device: string, name: string) => {
  await sidebar(page)
    .getByRole("radio", { name: new RegExp(`\\[walk-${device}\\]`) })
    .click();
  const project = sidebar(page).getByRole("button", {
    name: REAL_NAME,
    exact: true,
  });
  if (await project.isVisible()) await project.click();
  await sidebar(page)
    .getByRole("button", { name: new RegExp(`^${name} ${name} On `) })
    .click();
  await main(page)
    .getByRole("heading", { level: 1, name, exact: true })
    .waitFor();
};

// A destructive button's two clicks, as quick as a person's: once armed
// the button moves, and Playwright's wait for it to settle outlasts the
// arm.
const confirmTwice = (button: Locator) =>
  button.evaluate((element: HTMLElement) => {
    element.click();
    element.click();
  });

// The dialog picks the one device it can go to by itself, and draws
// again as it learns the devices: the menu is opened until it shows.
const pickDevice = async (page: Page, dialog: Locator, device: string) => {
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
  await item.click();
  await expect
    .poll(async () => (await button.textContent()) ?? "")
    .toMatch(named);
};

// The dialog's end: its success heading, or its failure's, which fails
// the walk with what the dialog says (the error the person reads).
const settle = async (page: Page, success: string, failure: string) => {
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
const mirror = async (lab: Lab, device?: string) => {
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
const transplant = async (lab: Lab, device?: string) => {
  await main(lab.page).getByRole("button", { name: "Options" }).click();
  await lab.page.getByText("Transplant", { exact: true }).click();
  const dialog = lab.page.getByRole("dialog", { name: "Transplant worktree" });
  if (device !== undefined) await pickDevice(lab.page, dialog, device);
  await dialog.getByRole("button", { name: "Start transplant" }).click();
  await settle(lab.page, "Transplant complete", "Transplant stopped");
  const done = lab.page.getByRole("dialog", { name: "Transplant complete" });
  await confirmTwice(
    done.getByRole("button", { name: "Tear down and finish" }),
  );
  await done.waitFor({ state: "hidden", timeout: 60_000 });
};

// ---- What the disks hold.

const checkouts = (lab: Lab, repo: string) =>
  lab
    .git(repo, "worktree", "list", "--porcelain")
    .split("\n\n")
    .flatMap((block) => {
      const path = /^worktree (.*)$/m.exec(block)?.[1];
      const branch = /^branch refs\/heads\/(.*)$/m.exec(block)?.[1];
      return path === undefined ? [] : [{ path, branch }];
    });

const cloneOn = (lab: Lab) => join(lab.home, REAL_NAME);
const projectOn = (lab: Lab) =>
  lab === a ? join(a.root, "repos", REAL_NAME) : cloneOn(lab);

// A clone from a peer reads as a clone of the remote: main at the
// remote's tip, origin/HEAD on it, main tracking it.
const expectCloneOfRemote = (lab: Lab) => {
  const clone = cloneOn(lab);
  expect(lab.git(clone, "symbolic-ref", "HEAD").trim()).toBe("refs/heads/main");
  expect(lab.git(clone, "rev-parse", "HEAD").trim()).toBe(
    lab.git(origin.path, "rev-parse", "main").trim(),
  );
  expect(
    lab.git(clone, "symbolic-ref", "refs/remotes/origin/HEAD").trim(),
  ).toBe("refs/remotes/origin/main");
  expect(
    lab.git(clone, "rev-parse", "--abbrev-ref", "main@{upstream}").trim(),
  ).toBe("origin/main");
};

// The worktree is on `lab`, on its branch, clean, its carried files
// there and ignored.
const expectLanded = async (lab: Lab, name: string) => {
  const repo = projectOn(lab);
  await expect
    .poll(() => checkouts(lab, repo).some((each) => each.branch === name))
    .toBe(true);
  const path =
    checkouts(lab, repo).find((each) => each.branch === name)?.path ?? repo;
  await expect
    .poll(() => lab.git(path, "status", "--porcelain").trim())
    .toBe("");
  for (const file of Object.keys(CARRIED)) {
    await expect
      .poll(() =>
        lab
          .git(
            path,
            "ls-files",
            "--others",
            "--ignored",
            "--exclude-standard",
            file,
          )
          .trim(),
      )
      .toBe(file);
  }
};

const expectGone = (lab: Lab, name: string) =>
  expect
    .poll(() =>
      checkouts(lab, projectOn(lab)).some((each) => each.branch === name),
    )
    .toBe(false);

// ---- The walks.

it("shows the other device read-only while its control is off, and its actions once it is on", async () => {
  const name = await quickCreate(a);
  await openPeerWorktree(b.page, "a", name);
  await main(b.page)
    .getByText(
      /Read-only until .*\[walk-a\] turns on .Allow control from other devices./,
    )
    .waitFor();
  expect(
    await main(b.page)
      .getByRole("button", { name: "Mirror", exact: true })
      .count(),
  ).toBe(0);
  await setControl(a.page, true);
  await main(b.page)
    .getByRole("button", { name: "Mirror", exact: true })
    .waitFor();
  await main(b.page).getByRole("button", { name: "Options" }).click();
  await b.page.getByText("Transplant", { exact: true }).waitFor();
  await b.page.keyboard.press("Escape");
});

it("mirrors a worktree to a device without the project: it clones the project as a laptop's clone reads, and the copy goes live there", async () => {
  await setControl(b.page, true);
  const name = await quickCreate(a);
  await main(a.page)
    .getByRole("button", { name: "Mirror", exact: true })
    .click();
  const dialog = a.page.getByRole("dialog", { name: "Mirror worktree" });
  await pickDevice(a.page, dialog, "b");
  await dialog.getByText("cloned first").waitFor();
  await dialog.getByRole("button", { name: "Start mirroring" }).click();
  await settle(a.page, "Mirror live", "Mirror didn't start");
  await a.page.keyboard.press("Escape");
  expectCloneOfRemote(b);
  await expectLanded(b, name);
});

it("mirrors a worktree to a device with the project at another path", async () => {
  const name = await quickCreate(a);
  await mirror(a, "b");
  await expectLanded(b, name);
});

it("mirrors the other device's worktree here, into the project here", async () => {
  const name = await quickCreate(a);
  await openPeerWorktree(b.page, "a", name);
  await mirror(b);
  await expectLanded(b, name);
});

it("sends a worktree to a device with the project at another path, and tears the source down", async () => {
  const name = await quickCreate(a);
  await transplant(a, "b");
  await expectLanded(b, name);
  await expectGone(a, name);
});

it("brings the other device's worktree here, into the project here, and tears the source down", async () => {
  const name = await quickCreate(a);
  await openPeerWorktree(b.page, "a", name);
  await transplant(b);
  await expectLanded(b, name);
  await expectGone(a, name);
});

it("sends a worktree to a device without the project: it clones first", async () => {
  const c = await devices.add("c", blank);
  await setControl(c.page, true);
  const name = await quickCreate(a);
  await transplant(a, "c");
  expectCloneOfRemote(c);
  await expectLanded(c, name);
  await expectGone(a, name);
  await devices.remove(c);
});

it("brings the other device's worktree to a device without the project: it clones first", async () => {
  const d = await devices.add("d", blank);
  const name = await quickCreate(a);
  await openPeerWorktree(d.page, "a", name);
  await transplant(d);
  expectCloneOfRemote(d);
  await expectLanded(d, name);
  await expectGone(a, name);
  await devices.remove(d);
});

it("mirrors the other device's worktree to a device without the project: it clones first", async () => {
  const e = await devices.add("e", blank);
  const name = await quickCreate(a);
  await openPeerWorktree(e.page, "a", name);
  await mirror(e);
  expectCloneOfRemote(e);
  await expectLanded(e, name);
  await devices.remove(e);
});
