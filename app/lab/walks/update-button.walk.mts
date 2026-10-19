// Settings' Restart to update in the packaged build, the path the
// owner's "Couldn't install the update" came through: an update staged
// and offered by a stand-in release list (a lab build updates from one
// alone), the press, and what comes back. A restart the person declines
// in the busy dialog leaves the app as it was, no error, the update still
// offered; one they go ahead with quits the app, and the installer's
// swap, which an unsigned lab bundle can't pass, brings the app back
// saying why.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { seedDemo } from "./lib/demoRepo.mts";
import { bootLab, type Lab } from "./lib/labApp.mts";
import { locked, skipWhenLocked } from "./lib/session.mts";
import { main, openPrimary, sidebar } from "./lib/page.mts";

const APP = "Shigoto no Mori (lab)";
// Above the lab build's 0.0.0.
const STAGED = "0.0.1";

let lab: Lab;
let server: Server;

// The release list offers the staged version, so the app's own check
// finds it staged already and keeps it ready.
const serveReleases = async () => {
  server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify([
        {
          tag_name: `v${STAGED}`,
          prerelease: false,
          body: "",
          published_at: new Date().toISOString(),
          assets: [
            {
              name: `${APP}-darwin-${process.arch}-${STAGED}.zip`,
              browser_download_url: "http://127.0.0.1:9/unused.zip",
            },
          ],
        },
      ]),
    );
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/releases`;
};

// What the window shows in a toast or a band, as it appears.
const recordShown = () =>
  lab.page.evaluate(() => {
    const seen: string[] = [];
    Object.assign(window, { shown: seen });
    new MutationObserver(() => {
      for (const node of document.querySelectorAll(
        "[role=status], [data-sonner-toast]",
      )) {
        const text = node.textContent ?? "";
        if (text !== "" && seen.at(-1) !== text) seen.push(text);
      }
    }).observe(document.body, {
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

// The busy dialog, a sheet on the app's window, through System Events.
const sheet = (pid: number, act: string) =>
  execFileSync(
    "osascript",
    [
      "-l",
      "JavaScript",
      "-e",
      `const app = Application("System Events").processes.whose({ unixId: ${pid} })[0];
const sheets = app.windows().flatMap((window) => window.sheets());
${act}`,
    ],
    { encoding: "utf8" },
  ).trim();
const sheets = (pid: number) => Number(sheet(pid, "sheets.length"));
const press = (pid: number, button: string) =>
  sheet(pid, `sheets[0].buttons.byName(${JSON.stringify(button)}).click();`);

const restartButton = () =>
  main(lab.page).getByRole("button", {
    name: new RegExp(`Restart to update to v${STAGED.replace(/\./g, "\\.")}`),
  });

// Settings' button, which restarts this machine's app at one click.
const pressRestart = async () => {
  if (!(await restartButton().isVisible())) {
    await sidebar(lab.page).getByRole("button", { name: "Settings" }).click();
  }
  await restartButton().click();
};

skipWhenLocked();

beforeAll(async () => {
  if (locked) return;
  const releases = await serveReleases();
  lab = await bootLab({
    seed: (dir, git) => void seedDemo(dir, git),
    env: { SHIGOMORI_UPDATE_RELEASES_URL: releases },
    prepare: (dataDir) => {
      const staged = join(dataDir, "updates", "staged");
      mkdirSync(join(staged, `${APP}.app`), { recursive: true });
      writeFileSync(
        join(staged, "manifest.json"),
        JSON.stringify({ version: STAGED, bundleName: `${APP}.app` }),
      );
    },
  });
  await openPrimary(lab.page, "demo");
  // A job in a terminal keeps the host busy, so a restart asks first.
  await lab.page
    .locator("footer")
    .getByText("Terminal", { exact: true })
    .click();
  await lab.page.locator(".xterm").click();
  await lab.page.keyboard.type("sleep 600");
  await lab.page.keyboard.press("Enter");
});
afterAll(async () => {
  await lab?.close();
  server?.close();
});

it("a restart declined in the busy dialog leaves the app as it was, the update still offered", async () => {
  const app = lab.pids()[0]?.pid ?? 0;
  await recordShown();
  await pressRestart();
  await expect.poll(() => sheets(app), { timeout: 15_000 }).toBe(1);
  press(app, "Cancel");
  await expect.poll(() => sheets(app)).toBe(0);
  await restartButton().waitFor();
  expect(lab.pids()[0]?.pid).toBe(app);
  expect(
    (await shown()).filter((text) => /couldn't|disconnected|wrong/i.test(text)),
  ).toEqual([]);
});

it("a restart gone ahead with quits, and a swap that fails brings the app back saying why", async () => {
  const app = lab.pids()[0]?.pid ?? 0;
  await recordShown();
  await pressRestart();
  await expect.poll(() => sheets(app), { timeout: 15_000 }).toBe(1);
  press(app, "Restart anyway");
  const page = await lab.followRelaunch();
  await expect
    .poll(() => page.locator("[data-sonner-toast]").allTextContents(), {
      timeout: 30_000,
    })
    .toContainEqual(
      expect.stringMatching(
        /The update didn't finish[\s\S]*no Team ID to verify the update against/,
      ),
    );
});
