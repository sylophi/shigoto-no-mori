// A window whose renderer is killed from outside the app comes back, in
// the packaged build: a SIGTERM and a SIGKILL of its renderer, and a
// SIGTERM of every process under it at once (as a `pkill` aimed at
// something else took them on 2026-10-17), the host and its children
// included.
import { execFileSync } from "node:child_process";
import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { withPageApi } from "../reliability/pageApi.mts";
import { seedDemo } from "./lib/demoRepo.mts";
import { bootLab, type Lab } from "./lib/labApp.mts";
import { main, openPrimary } from "./lib/page.mts";

let lab: Lab;
let repo: string;

const renderers = () =>
  lab
    .pids()
    .slice(1)
    .filter(({ command }) => command.includes("--type=renderer"))
    .map(({ pid }) => pid);

// The window is back where it was, on the worktree's page, and reads
// the repo through the host.
const usable = async (changed: string) => {
  const page = await lab.followWindow();
  await main(page).getByText(changed).waitFor({ timeout: 30_000 });
};

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

// Every process under the app's main one, the host's own children (the
// file-sync daemon, a git it runs) included.
const descendants = (root: number): number[] => {
  const rows = execFileSync("ps", ["-A", "-o", "pid=,ppid="], {
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number));
  const found: number[] = [];
  const walk = (parent: number) => {
    for (const [pid, ppid] of rows) {
      if (ppid === parent && pid !== undefined) {
        found.push(pid);
        walk(pid);
      }
    }
  };
  walk(root);
  return found;
};

// What the shell logged, from the lab home's logs folder.
const shellLog = () => {
  const logs = join(lab.home, "Library", "Logs");
  return readdirSync(logs, { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith("main.log"))
    .map((name) => readFileSync(join(logs, name), "utf8"))
    .join("");
};

it("a window the person closes stays closed", async () => {
  const before = renderers();
  await withPageApi(lab.page, (api) =>
    api.run(api.window.open({ route: "/" })),
  );
  await expect.poll(() => renderers().length).toBe(before.length + 1);
  const opened = renderers().find((pid) => !before.includes(pid));
  const pages = () =>
    lab.page
      .context()
      .pages()
      .filter((p) => !p.isClosed());
  await expect.poll(() => pages().length).toBe(2);
  const second = pages().find((page) => page !== lab.page);
  await second?.evaluate(() => window.close());
  await expect
    .poll(() => (opened === undefined ? true : !renderers().includes(opened)))
    .toBe(true);
  await expect.poll(() => pages().length).toBe(1);
  expect(renderers()).toEqual(before);
  expect(shellLog()).not.toContain("renderer gone");
});

for (const signal of ["SIGTERM", "SIGKILL"] as const) {
  it(`a window whose renderer gets ${signal} comes back`, async () => {
    const before = renderers();
    expect(before.length).toBeGreaterThan(0);
    for (const pid of before) process.kill(pid, signal);
    await expect
      .poll(() => renderers().some((pid) => !before.includes(pid)), {
        timeout: 30_000,
      })
      .toBe(true);
    await usable("4 files changed");
  });
}

it("every process under the app SIGTERMed at once: the host and the window both come back", async () => {
  const host = lab.hostPid();
  const app = lab.pids()[0]?.pid;
  expect(app).toBeDefined();
  for (const pid of descendants(app ?? 0)) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // One that went with another (a zygote's child) is gone already.
    }
  }
  await expect
    .poll(
      () => {
        try {
          return lab.hostPid() !== host;
        } catch {
          return false;
        }
      },
      { timeout: 60_000 },
    )
    .toBe(true);
  // What the new host reads, through the new window.
  appendFileSync(join(repo, "after-pkill.txt"), "new\n");
  await usable("5 files changed");
});
