// Devices of one account (lib/devices.mts) on a real project
// (lib/realRepo.mts) with the owner's settings: browsing the other
// device with its control off and on, and sending, bringing and
// mirroring to and from it, each with the project already there at
// another path and with it missing (cloned first), each started from
// the window a person would start it in. The windows are checked for
// what they say and the disks for what git did.
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { type Devices, startDevices } from "./lib/devices.mts";
import type { Lab } from "./lib/labApp.mts";
import {
  confirmTwice,
  mirror,
  openOwnWorktree,
  openPeerWorktree,
  pickDevice,
  quickCreate,
  setControl,
  settle,
  transplant,
} from "./lib/crossDevice.mts";
import { main } from "./lib/page.mts";
import {
  applyOwnerSettings,
  CARRIED,
  REAL_NAME,
  REAL_URL,
  type RealOrigin,
  seedRealProject,
  startRealOrigin,
  writeUserGit,
} from "./lib/realRepo.mts";

let origin: RealOrigin;
let devices: Devices;
// A holds the project; B starts without it and gets it from the first
// clone; each later "missing" case gets a device of its own.
let a: Lab;
let b: Lab;

const blank = (_reposDir: string, _git: Lab["git"], home: string) =>
  writeUserGit(home, origin);

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
// A walk that failed may leave its menu or dialog open over the next
// one's clicks.
afterEach(async () => {
  for (const lab of [a, b]) {
    if (lab === undefined) continue;
    const open = lab.page.locator('[role="dialog"], [role="menu"]');
    for (let tries = 0; tries < 6; tries += 1) {
      const count = await open.count();
      if (count === 0) break;
      await lab.page.keyboard.press("Escape");
      await expect
        .poll(() => open.count(), { timeout: 2_000 })
        .toBeLessThan(count)
        .catch(() => {});
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
const worktreeOn = (lab: Lab, name: string) =>
  checkouts(lab, projectOn(lab)).find((each) => each.branch === name)?.path ??
  "";
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
  // The remote as the source configured it, which this device fetches
  // through its own url.insteadOf, not the source's rewrite of it.
  expect(lab.git(clone, "config", "remote.origin.url").trim()).toBe(REAL_URL);
  lab.git(clone, "fetch", "-q", "origin");
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
  const name = await quickCreate(a, projectOn(a));
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
  const name = await quickCreate(a, projectOn(a));
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
  const name = await quickCreate(a, projectOn(a));
  await mirror(a, "b");
  await expectLanded(b, name);
});

it("mirrors the other device's worktree here, into the project here", async () => {
  const name = await quickCreate(a, projectOn(a));
  await openPeerWorktree(b.page, "a", name);
  await mirror(b);
  await expectLanded(b, name);
});

it("sends a worktree to a device with the project at another path, its own ignored files over the project's carry-over there, and tears the source down", async () => {
  // B's project as the owner keeps it there: the same settings, its own
  // carried files.
  applyOwnerSettings(b);
  for (const path of Object.keys(CARRIED)) {
    writeFileSync(join(projectOn(b), path), "B's project's\n");
  }
  const name = await quickCreate(a, projectOn(a));
  const source = worktreeOn(a, name);
  writeFileSync(join(source, "CLAUDE.local.md"), "the worktree's own\n");
  await transplant(a, "b");
  await expectLanded(b, name);
  expect(
    readFileSync(join(worktreeOn(b, name), "CLAUDE.local.md"), "utf8"),
  ).toBe("the worktree's own\n");
  await expectGone(a, name);
});

// A formatBytes size back in bytes.
const sizeOf = (value = "0", unit = "B") =>
  Number(value) * 1024 ** ["B", "KB", "MB", "GB", "TB"].indexOf(unit);

// Whether a transfer dialog's caption shows its files step under way on
// at least `bytes` (formatBytes: base 1024, B to TB).
const filesStepUnderWay = async (page: Page, bytes: number) => {
  const caption = page
    .getByRole("dialog")
    .last()
    .getByText(/^[\d.]+ [KMGT]?B of [\d.]+ [KMGT]?B$/);
  if ((await caption.count()) === 0) return false;
  const match = /^([\d.]+) ([KMGT]?B) of ([\d.]+) ([KMGT]?B)$/.exec(
    (await caption.first().textContent()) ?? "",
  );
  if (match === null) return false;
  const [, done, doneUnit, total, totalUnit] = match;
  const sent = sizeOf(done, doneUnit);
  const whole = sizeOf(total, totalUnit);
  return whole >= bytes * 0.9 && sent < whole;
};

// What a device's window reads off the hub, and its own id.
const hubView = (lab: Lab) =>
  lab.page.evaluate(
    `((api) => Promise.all([api.run(api.hub.status()), api.deviceId]))(window.__smLab.api)`,
  ) as Promise<[{ onlineDeviceIds: string[] }, string]>;

it("sends a worktree while the hub goes away: it completes over the direct link and both windows show it, or it stops with words and a retry starts clean, with no half state on either disk", async () => {
  const name = await quickCreate(a, projectOn(a));
  const source = worktreeOn(a, name);
  const head = a.git(source, "rev-parse", "HEAD").trim();
  // Ignored and large, so the files step is under way when the hub goes.
  const big = join("node_modules", "sm-walk-big.bin");
  const bigBytes = 300 * 1024 * 1024;
  mkdirSync(join(source, "node_modules"), { recursive: true });
  writeFileSync(join(source, big), Buffer.alloc(bigBytes, 7));
  const send = async () => {
    await main(a.page).getByRole("button", { name: "Options" }).click();
    await a.page.getByText("Transplant", { exact: true }).click();
    const dialog = a.page.getByRole("dialog", { name: "Transplant worktree" });
    await dialog
      .getByRole("radiogroup", { name: "What to leave out" })
      .waitFor();
    await pickDevice(a.page, dialog, "b");
    await dialog.getByRole("button", { name: "Start transplant" }).click();
  };
  const ended = a.page.getByRole("heading", {
    name: /^(Transplant complete|Transplant stopped)$/,
  });
  const ids = [(await hubView(a))[1], (await hubView(b))[1]] as const;
  await send();
  let outcome: string | null = null;
  try {
    // The cut lands while the files step carries the big file: the
    // dialog's caption reads "<bytes> of <total>" with the total that
    // file's, short of it.
    await expect
      .poll(() => filesStepUnderWay(a.page, bigBytes), {
        timeout: 120_000,
        interval: 100,
      })
      .toBe(true);
    await devices.hub.pause();
    await ended.waitFor({ timeout: 180_000 });
    outcome = await ended.textContent();
    if (outcome === "Transplant stopped") {
      const said = await a.page.getByRole("dialog").last().innerText();
      expect(said.replace("Transplant stopped", "").trim()).not.toBe("");
      await a.page.keyboard.press("Escape");
    }
  } finally {
    await devices.hub.resume();
  }
  // Back on the hub, each sees the other, as the device it was.
  for (const [lab, other, otherBefore] of [
    [a, b, ids[1]],
    [b, a, ids[0]],
  ] as const) {
    const otherId = (await hubView(other))[1];
    expect(otherId).toBe(otherBefore);
    await expect
      .poll(async () => (await hubView(lab))[0].onlineDeviceIds, {
        timeout: 60_000,
      })
      .toContain(otherId);
  }
  if (outcome === "Transplant stopped") {
    // Nothing of it on B, and A's worktree as it was.
    expect(
      checkouts(b, projectOn(b)).some((each) => each.branch === name),
    ).toBe(false);
    expect(b.git(projectOn(b), "branch", "--list", name).trim()).toBe("");
    expect(a.git(source, "rev-parse", "HEAD").trim()).toBe(head);
    expect(statSync(join(source, big)).size).toBe(bigBytes);
    // A retry starts clean.
    await transplant(a, "b");
  } else {
    // Both windows show it: A's dialog its end, B the worktree's page.
    const done = a.page.getByRole("dialog", { name: "Transplant complete" });
    await confirmTwice(
      done.getByRole("button", { name: "Tear down and finish" }),
    );
    await done.waitFor({ state: "hidden", timeout: 60_000 });
    await openOwnWorktree(b.page, name);
  }
  await expectLanded(b, name);
  expect(statSync(join(worktreeOn(b, name), big)).size).toBe(bigBytes);
  await expectGone(a, name);
});

it("brings the other device's worktree here, into the project here, and tears the source down", async () => {
  const name = await quickCreate(a, projectOn(a));
  await openPeerWorktree(b.page, "a", name);
  await transplant(b);
  await expectLanded(b, name);
  await expectGone(a, name);
});

it("sends a worktree to a device without the project: it clones first", async () => {
  const c = await devices.add("c", blank);
  await setControl(c.page, true);
  const name = await quickCreate(a, projectOn(a));
  await transplant(a, "c");
  expectCloneOfRemote(c);
  await expectLanded(c, name);
  await expectGone(a, name);
  await devices.remove(c);
});

it("brings the other device's worktree to a device without the project: it clones first", async () => {
  const d = await devices.add("d", blank);
  const name = await quickCreate(a, projectOn(a));
  await openPeerWorktree(d.page, "a", name);
  await transplant(d);
  expectCloneOfRemote(d);
  await expectLanded(d, name);
  await expectGone(a, name);
  await devices.remove(d);
});

it("mirrors the other device's worktree to a device without the project: it clones first", async () => {
  const e = await devices.add("e", blank);
  const name = await quickCreate(a, projectOn(a));
  await openPeerWorktree(e.page, "a", name);
  await mirror(e);
  expectCloneOfRemote(e);
  await expectLanded(e, name);
  await devices.remove(e);
});
