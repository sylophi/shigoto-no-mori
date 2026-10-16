// The app's host restarting under the window, in the packaged build: a
// host that dies, and one that stops answering until the shell's
// watchdog starts it again. The window says it is reconnecting and
// then why the host restarted, shows no error toast, and its page reads
// the new host's state on its own. And the app's links through what a
// laptop does to it: the window's timers stopped past every limit, as a
// hidden window's throttled ones are late, and the whole app stopped as
// a sleep stops it, with a commit sent as it stopped landing once.
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { seedDemo } from "./lib/demoRepo.mts";
import { bootLab, type Lab } from "./lib/labApp.mts";
import { main, openPrimary } from "./lib/page.mts";

let lab: Lab;
let repo: string;

// Every band and toast the window shows, recorded as it appears: the
// band can be up for less than a second, and a toast goes on its own.
const recordShown = () =>
  lab.page.evaluate(() => {
    const seen: string[] = [];
    Object.assign(window, { shown: seen });
    const note = () => {
      for (const node of document.querySelectorAll(
        "[role=status], [data-sonner-toast]",
      )) {
        const text = node.textContent ?? "";
        if (text !== "" && seen.at(-1) !== text) seen.push(text);
      }
    };
    new MutationObserver(note).observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
    });
  });
const shown = () =>
  lab.page.evaluate(() =>
    "shown" in window && Array.isArray(window.shown)
      ? window.shown.map(String)
      : [],
  );

beforeAll(async () => {
  lab = await bootLab({
    seed: (dir, git) => {
      repo = seedDemo(dir, git);
    },
  });
  await openPrimary(lab.page, "demo");
  await main(lab.page).getByText("4 files changed").waitFor();
});
afterAll(() => lab?.close());

it("a host that dies is started again, and the page carries on", async () => {
  await recordShown();
  process.kill(lab.hostPid(), "SIGKILL");
  await expect
    .poll(shown, { timeout: 30_000 })
    .toContainEqual(
      expect.stringMatching(/background process quit unexpectedly/),
    );
  appendFileSync(join(repo, "after-kill.txt"), "new\n");
  await main(lab.page)
    .getByText("5 files changed")
    .waitFor({ timeout: 30_000 });
  const texts = await shown();
  expect(texts).toContain("Reconnecting to the app's background process…");
  expect(texts.filter((text) => /wrong|device/i.test(text))).toEqual([]);
});

it("a host that stops answering is started again by the watchdog, and a page it held comes back", async () => {
  await recordShown();
  const host = lab.hostPid();
  process.kill(host, "SIGSTOP");
  try {
    appendFileSync(join(repo, "while-stopped.txt"), "new\n");
    // A page whose reads the stopped host holds until the restart.
    await main(lab.page).getByText("5 files changed").click();
    await expect
      .poll(shown, { timeout: 60_000 })
      .toContainEqual(
        expect.stringMatching(/stopped responding for 30 seconds/),
      );
  } finally {
    try {
      process.kill(host, "SIGCONT");
    } catch {
      // Killed by the watchdog.
    }
  }
  await main(lab.page)
    .getByRole("heading", { name: "Uncommitted changes" })
    .waitFor({ timeout: 30_000 });
  await lab.page
    .locator("aside")
    .getByText("while-stopped.txt", { exact: true })
    .waitFor({ timeout: 30_000 });
  const texts = await shown();
  expect(texts).toContain("Reconnecting to the app's background process…");
  expect(texts.filter((text) => /wrong|device/i.test(text))).toEqual([]);
});

// Stops each process for `ms`, then lets it run again.
async function stopped(pids: number[], ms: number): Promise<void> {
  for (const pid of pids) process.kill(pid, "SIGSTOP");
  try {
    await new Promise((resolve) => setTimeout(resolve, ms));
  } finally {
    for (const pid of pids) process.kill(pid, "SIGCONT");
  }
}

it("a window whose timers ran late past every limit carries on with its host", async () => {
  await recordShown();
  const renderer = lab
    .pids()
    .filter(({ command }) => command.includes("--type=renderer"))
    .map(({ pid }) => pid);
  appendFileSync(join(repo, "while-hidden.txt"), "new\n");
  // Past the window's old 40 s ping limit and a throttled minute.
  await stopped(renderer, 75_000);
  await lab.page
    .locator("aside")
    .getByText("while-hidden.txt", { exact: true })
    .waitFor({ timeout: 30_000 });
  const texts = await shown();
  expect(
    texts.filter((text) => /background process|wrong|device/i.test(text)),
  ).toEqual([]);
});

it("the whole app stopped past every limit, as a sleep stops it, carries on, and a commit sent as it stopped lands once", async () => {
  await recordShown();
  const commits = () =>
    Number(lab.git(repo, "rev-list", "--count", "HEAD").trim());
  const before = commits();
  await lab.page.getByLabel("Commit summary").fill("Commit across a stop");
  const all = lab.pids().map(({ pid }) => pid);
  await lab.page.getByRole("button", { name: /^Commit all \d+ files/ }).click();
  // Past the host's old 120 s cut of a silent link, and the watchdog's.
  await stopped(all, 130_000);
  await expect
    .poll(() => lab.git(repo, "log", "-1", "--format=%s").trim(), {
      timeout: 30_000,
    })
    .toBe("Commit across a stop");
  appendFileSync(join(repo, "after-stop.txt"), "new\n");
  await lab.page
    .locator("aside")
    .getByText("after-stop.txt", { exact: true })
    .waitFor({ timeout: 30_000 });
  expect(commits()).toBe(before + 1);
  const texts = await shown();
  expect(
    texts.filter((text) => /background process|wrong|device/i.test(text)),
  ).toEqual([]);
  // No host was started again: the watchdog's round the stop held
  // proved nothing.
  expect(
    execFileSync(
      "grep",
      [
        "-c",
        "starting it again",
        join(lab.home, "Library/Logs/Shigoto no Mori (lab)/main.log"),
      ],
      { encoding: "utf8" },
    ).trim(),
  ).toBe("2");
});
