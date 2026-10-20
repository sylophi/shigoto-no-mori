// A packaged build's relaunch must leave a live window: opens the app
// for the lab, has it relaunch (what the migration, a data-folder move
// and a nuke end with), waits past the second or so after which macOS
// terminates a quit app's subordinate processes (main/electron/
// relaunch.ts), and reads the new window again. Fails, naming what it
// saw, when the new instance never came, its window drew nothing, or a
// child process was killed.
//
// A packaged build takes no debugging port (main/electron/
// debugSwitches.ts), so the lab asks and looks from outside: started
// with --sm-lab, the app relaunches on SIGUSR2 (main/index.ts); the
// window is read through macOS accessibility, which a page whose
// renderer died has nothing in (as the flavors thread drove its window); and main.log says which child process
// was killed. Accessibility needs the terminal running this to be
// allowed in System Settings > Privacy & Security > Accessibility.
//
// Run: node lab/relaunch.mts "<path to the .app>"
// A v3 build (SM_FLAVOR=v3 pnpm package) runs beside the installed
// app. It quits the app at the end, by SIGKILL (a window whose renderer
// was killed ignores a quit), whether it passed or not.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { onRunEnd, signalIfAlive } from "./lib/runEnd.mts";

const given = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
if (given === undefined || !existsSync(given)) {
  console.error('Usage: node lab/relaunch.mts "<path to the .app>"');
  process.exit(2);
}
// Whole: `open -a` reads a relative path as an app's name.
const bundle = resolve(given);
const appName = basename(bundle, ".app");
const executable = join(bundle, "Contents", "MacOS", appName);
const mainLog = join(homedir(), "Library", "Logs", appName, "main.log");

// Every running instance of the app, its main process by its command.
const pidsOfApp = (): number[] => {
  try {
    const pattern = executable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const out = execFileSync("pgrep", ["-f", `^${pattern} `], {
      encoding: "utf8",
    });
    return out
      .trim()
      .split("\n")
      .map(Number)
      .filter((pid) => pid > 0);
  } catch {
    return [];
  }
};
const pidOfApp = (): number | null => pidsOfApp()[0] ?? null;

// What the app's windows show, through accessibility (JavaScript for
// Automation over System Events), for `pid`.
const accessibility = (pid: number, body: string): string => {
  const script = `
    const app = Application("System Events").processes.whose({ unixId: ${pid} })[0];
    ${body}`;
  try {
    return execFileSync("osascript", ["-l", "JavaScript", "-e", script], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    const said = String((error as { stderr?: unknown }).stderr ?? error);
    if (said.includes("assistive access")) {
      console.error(
        "The terminal running this isn't allowed to use accessibility (System Settings > Privacy & Security > Accessibility).",
      );
      process.exit(2);
    }
    return "";
  }
};

const hasWindow = (pid: number) =>
  accessibility(pid, "app.windows.length;") === "1";

// Chromium builds a page's tree only for a client that asks for it, by
// AXManualAccessibility on the app, and hears the ask only as its value
// changes, so it is asked once the page is there.
const askForTree = (pid: number) =>
  accessibility(
    pid,
    `const ask = app.attributes.byName("AXManualAccessibility");
    ask.value = false;
    ask.value = true;`,
  );

// How many texts and buttons the app's window shows: a few at least
// once it draws a page, none once its renderer is gone.
const drawn = (pid: number): number =>
  Number(
    accessibility(
      pid,
      `app.windows[0].entireContents().filter(
        (element) => ["AXStaticText", "AXButton"].includes(element.role()),
      ).length;`,
    ) || 0,
  );

// A window that draws a page shows a few of each at least.
const LIVE = 5;

// The pid's window once it draws a page, after `since`, in ms.
const drawnWindow = async (pid: number, since: number) => {
  await until("its window", 30_000, () => (hasWindow(pid) ? true : null));
  // The page loads behind the window before it can be asked.
  await sleep(2000);
  askForTree(pid);
  return until("its page", 30_000, () =>
    drawn(pid) >= LIVE ? Date.now() - since : null,
  );
};

// Polls `probe` every 500 ms until it answers something, for `ms`.
const until = async <A,>(
  what: string,
  ms: number,
  probe: () => A | null,
  end = Date.now() + ms,
): Promise<A> => {
  const value = probe();
  if (value !== null) return value;
  if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
  await sleep(500);
  return until(what, ms, probe, end);
};

const killedLines = () =>
  existsSync(mainLog)
    ? readFileSync(mainLog, "utf8")
        .split("\n")
        .filter((line) => line.includes("reason=killed"))
    : [];

if (pidOfApp() !== null) {
  console.error(`${appName} is running. Quit it first.`);
  process.exit(2);
}
// The app runs from LaunchServices, not as this script's child, so it
// is quit here however the run ends (lib/runEnd.mts): a failure, an
// exit, a signal.
onRunEnd(() => {
  for (const pid of pidsOfApp()) signalIfAlive(pid, "SIGKILL");
});
const opened = Date.now();
execFileSync("open", ["-n", "-a", bundle, "--args", "--sm-lab"]);
const first = await until("the app", 60_000, () => pidOfApp());
await drawnWindow(first, opened);
const killedBefore = killedLines().length;
const asked = Date.now();
process.kill(first, "SIGUSR2");
const second = await until("the relaunched app", 60_000, () => {
  const pid = pidOfApp();
  return pid !== null && pid !== first ? pid : null;
});
const windowBack = await drawnWindow(second, asked).catch(() => null);
// Past the subordinate termination, which lands a second or so after
// the old instance is gone.
await sleep(5000);
const later = drawn(second);
const killed = killedLines().slice(killedBefore);
console.log(
  `relaunched as ${second} (was ${first}), window ${windowBack === null ? "never drew" : `drawn in ${windowBack} ms`}`,
);
console.log(`5 s later the window shows ${later} texts and buttons`);
for (const line of killed) console.log(`  ${line}`);
if (later < LIVE || killed.length > 0) {
  console.error("FAIL: the relaunched app lost its window or a child process");
  process.exit(1);
}
console.log("ok: the relaunched app kept its window");
