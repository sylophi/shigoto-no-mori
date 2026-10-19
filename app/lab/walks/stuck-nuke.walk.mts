// A nuke whose start can't delete a file, on the packaged lab build
// (main/electron/nuke.ts openPastStuckNuke): the start asks before it
// opens, naming the file and why, with Show in Finder, Open Without
// Finishing and Quit. Quit leaves the marker for the next start to
// finish; Open Without Finishing drops it and opens the app. The dialog
// is the system's own, in its appearance: read here through System
// Events, as a person's screen reader would.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { bootLab, type Lab } from "./lib/labApp.mts";
import { locked, skipWhenLocked } from "./lib/session.mts";
import { waitFor } from "../../test/lib/checkKit.mts";

// The marker a nuke writes in userData (main/core/nuke/finish.ts).
const NUKE_MARKER = "nuke.pending";

let lab: Lab;
let held: string;

// The app's alert, a window of its own, through System Events: its
// texts, or a press of one of its buttons.
const alert = (pid: number, act: string) =>
  execFileSync(
    "osascript",
    [
      "-l",
      "JavaScript",
      "-e",
      `const app = Application("System Events").processes.whose({ unixId: ${pid} })[0];
const alerts = app.windows().filter((window) => window.buttons().length > 0);
${act}`,
    ],
    { encoding: "utf8", timeout: 10_000 },
  ).trim();
// None yet, also while System Events doesn't list the new app.
const shown = (pid: number): { texts: string[]; buttons: string[] } | null => {
  try {
    return JSON.parse(
      alert(
        pid,
        `JSON.stringify(alerts.length === 0 ? null : {
  texts: alerts[0].staticTexts().map((text) => text.value()),
  buttons: alerts[0].buttons().map((button) => button.name()),
})`,
      ),
    ) as { texts: string[]; buttons: string[] } | null;
  } catch {
    return null;
  }
};
const answer =
  (
    button: string,
    seen: (dialog: { texts: string[]; buttons: string[] }) => void,
  ) =>
  async (pid: number) => {
    let dialog: { texts: string[]; buttons: string[] } | null = null;
    await waitFor(
      () => (dialog = shown(pid)) !== null,
      "the stuck nuke's dialog",
      30_000,
    );
    if (dialog !== null) seen(dialog);
    alert(pid, `alerts[0].buttons.byName(${JSON.stringify(button)}).click();`);
  };

// A nuke's marker naming a file in a folder it can't leave (a
// worktree's read-only directory).
const stuck = () => {
  mkdirSync(held, { recursive: true });
  writeFileSync(join(held, "file"), "x");
  chmodSync(held, 0o500);
  writeFileSync(
    join(lab.userData, NUKE_MARKER),
    JSON.stringify({ paths: [join(held, "file")] }),
  );
};

skipWhenLocked();

beforeAll(async () => {
  if (locked) return;
  lab = await bootLab({ seed: () => {}, profile: "stuck-nuke" });
  held = join(lab.root, "held");
});
afterAll(async () => {
  if (held !== undefined && existsSync(held)) chmodSync(held, 0o700);
  await lab?.close();
});

it("a start that couldn't finish a nuke names what stayed, and Quit keeps the marker", async () => {
  let dialog: { texts: string[]; buttons: string[] } | undefined;
  await expect(
    lab.restart({
      between: stuck,
      atStart: answer("Quit", (seen) => {
        dialog = seen;
      }),
    }),
  ).rejects.toThrow(/exited/);
  // In the order the system lays them out, not the app's.
  expect(dialog?.buttons.toSorted()).toEqual([
    "Open Without Finishing",
    "Quit",
    "Show in Finder",
  ]);
  const words = dialog?.texts.join("\n") ?? "";
  expect(words).toContain("couldn't finish erasing itself");
  expect(words).toContain(join(held, "file"));
  expect(words).toMatch(/permission denied/i);
  expect(existsSync(join(lab.userData, NUKE_MARKER))).toBe(true);
});

it("Open Without Finishing drops the marker and opens the app", async () => {
  await lab.restart({ atStart: answer("Open Without Finishing", () => {}) });
  expect(existsSync(join(lab.userData, NUKE_MARKER))).toBe(false);
  expect(existsSync(join(held, "file"))).toBe(true);
  await expect.poll(() => lab.page.locator("#root").count()).toBeGreaterThan(0);
});
