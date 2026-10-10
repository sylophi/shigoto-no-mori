// The scenarios, and what recovering from one means for a tab: its hub
// socket connected and its session to the host up, the host's
// indicator reading Connected, the host's worktrees as listed through
// the hub and as drawn in the sidebar both matching what the host
// itself says, no uncaught error, and no failed request the tab's log
// says nothing about. Each scenario changes the host's worktrees while
// the tab is cut off, so a view that did not catch up shows as stale.
/* oxlint-disable no-await-in-loop -- the harness steps through time on purpose: each wait, poll and scenario follows the one before */
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import {
  repoDir,
  sleep,
  within,
  type Lab,
  type Tab,
  type TraceLine,
} from "./lab.mts";

export type Scenario = {
  readonly name: string;
  // What it does, for the report.
  readonly does: string;
  // How long the tabs get to recover, from the moment the disruption
  // ends.
  readonly boundMs: number;
  // Runs the disruption and answers when it ended. Only in a run that
  // names it, for a scenario the rest cannot follow.
  readonly run: (lab: Lab, random: () => number) => Promise<number>;
  // Leaves the profile signed out, so it runs only when named, last,
  // and checks its own outcome rather than a recovery.
  readonly destructive?: boolean;
};

type TabState = {
  socket: string;
  session: boolean;
  indicator: boolean;
  listed: string[] | null;
  shown: string[] | null;
};

async function stateOf(lab: Lab, tab: Tab): Promise<TabState> {
  const { host } = lab;
  const inPage = await within(
    10_000,
    `${tab.name}'s state`,
    tab.page.evaluate(
      async ({ deviceId, projectId, label }) => {
        const status = await window.api.hub.status();
        const listed = await Promise.race([
          window.api.hub
            .invokePeer({
              deviceId,
              channel: "worktrees:list",
              input: { projectId },
            })
            .then((rows) =>
              (rows as Array<{ branch: string | null }>)
                .map((row) => row.branch ?? "")
                .toSorted(),
            ),
          new Promise<null>((done) => setTimeout(() => done(null), 3000)),
        ]).catch(() => null);
        const rows = [...document.querySelectorAll("aside button")].filter(
          (button) =>
            button.querySelector(`[aria-label="On ${CSS.escape(label)}"]`) !==
              null && button.querySelector("span") !== null,
        );
        return {
          socket: status.socket.phase,
          session: deviceId in status.peerAppVersions,
          listed,
          shown:
            rows.length === 0
              ? null
              : rows
                  .map((row) => row.querySelector("span")?.textContent ?? "")
                  .toSorted(),
        };
      },
      {
        deviceId: host.deviceId,
        projectId: host.projectId,
        label: host.label,
      },
    ),
  );
  const indicator =
    (await tab.page
      .getByRole("radio", { name: `${host.label}, Connected`, exact: true })
      .count()) > 0;
  return { ...inPage, indicator };
}

// Opens the host's project in the sidebar's Projects layout, so its
// worktrees are drawn.
export async function showProject(lab: Lab, tab: Tab): Promise<void> {
  const layout = tab.page.getByRole("radio", { name: "Projects", exact: true });
  if ((await layout.count()) > 0 && !(await layout.isChecked())) {
    await layout.click();
  }
  const project = tab.page
    .locator("aside")
    .getByRole("button", { name: lab.host.projectName, exact: true });
  if ((await project.count()) > 0) await project.first().click();
}

const same = (a: string[] | null, b: string[]) =>
  a !== null && JSON.stringify(a) === JSON.stringify(b);

// What still stands between a tab and recovered, or null.
function unrecovered(state: TabState, expected: string[]): string | null {
  if (state.socket !== "connected") return `hub socket ${state.socket}`;
  if (!state.session) return "no session to the host";
  if (!state.indicator) return "the host's indicator does not read Connected";
  if (!same(state.listed, expected)) {
    return `listed through the hub ${JSON.stringify(state.listed)}, the host has ${JSON.stringify(expected)}`;
  }
  if (!same(state.shown, expected)) {
    return `the sidebar shows ${JSON.stringify(state.shown)}, the host has ${JSON.stringify(expected)}`;
  }
  return null;
}

// Waits for every tab to recover, answering how long the slowest took
// from `since`, or throws with what was still wrong at the bound.
export async function recovered(
  lab: Lab,
  since: number,
  boundMs: number,
): Promise<number> {
  const expected = lab.hostBranches();
  const pending = new Map(lab.tabs.map((tab) => [tab, "not checked yet"]));
  // When each tab was last asked to open the project, which a reload
  // closes, so its rows are drawn to compare.
  const opened = new Map<Tab, number>();
  let slowest = 0;
  while (pending.size > 0) {
    for (const tab of pending.keys()) {
      let reason: string | null;
      try {
        const state = await stateOf(lab, tab);
        if (
          state.shown === null &&
          state.session &&
          Date.now() - (opened.get(tab) ?? 0) > 3000
        ) {
          opened.set(tab, Date.now());
          await showProject(lab, tab);
        }
        reason = unrecovered(state, expected);
      } catch (error) {
        reason = `the tab did not answer: ${String(error)}`;
      }
      if (reason === null) {
        pending.delete(tab);
        slowest = Math.max(slowest, Date.now() - since);
      } else {
        pending.set(tab, reason);
      }
    }
    if (pending.size === 0) break;
    if (Date.now() - since > boundMs) {
      throw new Error(
        [...pending]
          .map(([tab, reason]) => `${tab.name}: ${reason}`)
          .join("; "),
      );
    }
    await sleep(250);
  }
  return slowest;
}

// The failures in a window of the trace that broke the rules: an
// uncaught error, or a tab whose requests failed while it logged
// nothing about its connection.
export function silentFailures(lines: TraceLine[]): string[] {
  const found: string[] = [];
  for (const line of lines) {
    if (line.level === "pageerror") {
      found.push(`${line.source}: uncaught ${line.text.split("\n")[0]}`);
    }
  }
  const sources = new Set(lines.map((line) => line.source));
  for (const source of sources) {
    const own = lines.filter((line) => line.source === source);
    const failed = own.filter((line) => line.level === "requestfailed");
    const explained = own.some(
      (line) =>
        line.level === "warning" ||
        line.level === "error" ||
        /^\[(hub|direct|link)\]/.test(line.text),
    );
    if (failed.length > 0 && !explained) {
      found.push(
        `${source}: ${failed.length} failed requests and no log line (${failed[0]?.text})`,
      );
    }
  }
  return found;
}

// ---- changing the host while the tab cannot see it ----

let worktreeCount = 0;

// Adds a worktree on the host, and removes the oldest the harness made
// past three, so the list a recovered tab shows has to be a new one.
function changeHost(lab: Lab): void {
  const name = `rel-${Date.now().toString(36)}-${++worktreeCount}`;
  lab.smdRun(["worktrees", "create", name, "--no-cd"]);
  const made = lab
    .smdJson<Array<{ name: string }>>(["worktrees", "list", "--identities"])
    .map((row) => row.name)
    .filter((each) => each.startsWith("rel-"))
    .toSorted();
  for (const old of made.slice(0, Math.max(0, made.length - 3))) {
    try {
      lab.smdRun(["worktrees", "rm", old, "-f"]);
    } catch (error) {
      lab.note(`could not remove ${old}: ${String(error)}`, "warning");
    }
  }
  lab.note(`host now has ${lab.hostBranches().join(", ")}`);
}

const between = (random: () => number, lowMs: number, highMs: number) =>
  Math.round(lowMs + random() * (highMs - lowMs));

async function forEachTab(lab: Lab, fn: (tab: Tab) => Promise<void>) {
  await Promise.all(lab.tabs.map(fn));
}

// ---- the scenarios ----

// How long the tabs took to stop reading the host as Connected once
// the network went, which a browser that says it is offline has no
// reason to wait out.
async function outageShown(lab: Lab, boundMs: number): Promise<number> {
  const since = Date.now();
  const label = lab.host.label;
  await waitUntil(
    "every tab to stop showing the host as Connected while offline",
    async () => {
      for (const tab of lab.tabs) {
        const connected = await tab.page
          .getByRole("radio", { name: `${label}, Connected`, exact: true })
          .count();
        if (connected > 0) return false;
      }
      return true;
    },
    boundMs,
  );
  return Date.now() - since;
}

const networkDrop: Scenario = {
  name: "network-drop",
  does: "The network goes for 20 to 60 s (every flow stalls, new ones are refused, the browser reports offline) and comes back changed: the stalled flows are cut.",
  boundMs: 30_000,
  async run(lab, random) {
    const ms = between(random, 20_000, 60_000);
    lab.note(`network down for ${ms} ms`);
    const down = Date.now();
    lab.network.down();
    await forEachTab(lab, (tab) => tab.setOffline(true));
    changeHost(lab);
    const shown = await outageShown(lab, 10_000);
    lab.note(`the outage showed after ${shown} ms`);
    await sleep(Math.max(0, down + ms - Date.now()));
    lab.network.restore({ cut: true });
    await forEachTab(lab, (tab) => tab.setOffline(false));
    lab.note("network back, the old flows cut");
    return Date.now();
  },
};

const networkBlip: Scenario = {
  name: "network-blip",
  does: "Every flow stalls for 5 to 15 s and then resumes, with no offline event: a network that hiccups without the browser noticing.",
  boundMs: 30_000,
  async run(lab, random) {
    const ms = between(random, 5_000, 15_000);
    lab.note(`network stalled for ${ms} ms`);
    lab.network.down();
    changeHost(lab);
    await sleep(ms);
    lab.network.restore({ cut: false });
    lab.note("network resumed");
    return Date.now();
  },
};

const hubRedeploy: Scenario = {
  name: "hub-redeploy",
  does: "The dev hub is deployed again from this checkout's hub/ (wrangler deploy --env dev), which restarts its Durable Objects and drops every socket.",
  boundMs: 60_000,
  async run(lab) {
    changeHost(lab);
    const started = Date.now();
    lab.note("deploying the dev hub");
    // Deploying the same code again is a version the objects survive,
    // so the deploy carries a variable of its own, which nothing reads,
    // to make it a version that restarts them.
    execFileSync(
      "pnpm",
      ["run", "deploy", "--var", `REDEPLOYED_AT:${new Date().toISOString()}`],
      { cwd: join(repoDir, "hub"), stdio: "ignore" },
    );
    const deployed = Date.now();
    lab.note("the dev hub is deployed");
    // A socket of an object that hibernated rides through a deploy, so
    // when none drops, the flows are cut, and every tab dials the new
    // version, which is what a deploy has to survive.
    const dropped = await waitUntil(
      "a tab to see the redeploy drop its hub socket",
      async () =>
        lab.trace.some(
          (line) =>
            line.at >= started &&
            line.source.startsWith("tab") &&
            /^\[hub\] socket (backoff|connecting)/.test(line.text),
        ),
      20_000,
    ).then(
      () => true,
      () => false,
    );
    if (dropped) return deployed;
    lab.note("the hub sockets rode through the deploy; cutting them");
    lab.network.down();
    lab.network.restore({ cut: true });
    return Date.now();
  },
};

const hostKill: Scenario = {
  name: "host-kill",
  does: "The host's process is killed (SIGKILL); the shell forks it again and the web client has to find it.",
  boundMs: 60_000,
  async run(lab) {
    const pid = lab.hostPid();
    if (pid === null) throw new Error("no host process to kill");
    lab.note(`killing the host process ${pid}`);
    process.kill(pid, "SIGKILL");
    changeHost(lab);
    return Date.now();
  },
};

const appRelaunch: Scenario = {
  name: "app-relaunch",
  does: "The whole dev app is quit (its launcher's process group signalled), the host changed meanwhile, and the app launched again.",
  boundMs: 60_000,
  async run(lab) {
    lab.note("stopping the host app");
    await lab.stopHostApp();
    changeHost(lab);
    lab.note("launching the host app again");
    await lab.launchHost(false);
    lab.note("the host app is up");
    return Date.now();
  },
};

const tabSleep: Scenario = {
  name: "tab-sleep",
  does: "Every tab is hidden and frozen and the network goes, for 30 to 120 s (past a hub ticket's 60 s life about half the time), then the network comes back changed and the tabs wake.",
  boundMs: 30_000,
  async run(lab, random) {
    const ms = between(random, 30_000, 120_000);
    lab.note(`tabs asleep for ${ms} ms`);
    await forEachTab(lab, (tab) => tab.setHidden(true));
    await forEachTab(lab, (tab) => tab.setFrozen(true));
    lab.network.down();
    changeHost(lab);
    await sleep(ms);
    lab.network.restore({ cut: true });
    await forEachTab(lab, async (tab) => {
      await tab.setFrozen(false);
      await tab.setOffline(false);
      await tab.setHidden(false);
    });
    lab.note("tabs awake");
    return Date.now();
  },
};

const reloadAndSecondTab: Scenario = {
  name: "reload-and-second-tab",
  does: "The first tab is reloaded and has to recover, then a second tab of the profile is opened and both have to hold, then the second closes and the first has to stay.",
  boundMs: 30_000,
  async run(lab) {
    const [first] = lab.tabs;
    if (first === undefined) throw new Error("no tab");
    changeHost(lab);
    lab.note(`reloading ${first.name}`);
    await first.page.reload();
    await recovered(lab, Date.now(), 30_000);
    const second = await lab.openTab();
    lab.note(`opened ${second.name}`);
    await recovered(lab, Date.now(), 30_000);
    await lab.closeTab(second);
    lab.note(`closed ${second.name}`);
    changeHost(lab);
    return Date.now();
  },
};

const twoTabsRedial: Scenario = {
  name: "two-tabs-redial",
  does: "A second tab of the profile is opened, and both tabs' flows are cut at once, three times, so both dial the host together each time; every tab has to recover each time. A host that mints a device's direct tickets as one set refuses one of two tabs dialing together, and that tab has to ask again.",
  boundMs: 30_000,
  async run(lab) {
    const second = await lab.openTab();
    await recovered(lab, Date.now(), this.boundMs);
    for (let round = 1; round <= 3; round++) {
      // Past the supervisors' stable threshold, so each round's redial
      // starts at the bottom of their ladders rather than climbing it.
      await sleep(35_000);
      changeHost(lab);
      lab.network.down();
      lab.network.restore({ cut: true });
      lab.note(`both tabs cut, round ${round}`);
      const took = await recovered(lab, Date.now(), this.boundMs);
      lab.note(`round ${round} recovered in ${took} ms`);
    }
    await lab.closeTab(second);
    return Date.now();
  },
};

const tokenExpiry: Scenario = {
  name: "token-expiry",
  does: "Every tab's wall clock jumps two hours ahead, past the Clerk session token's minute and a hub ticket's minute, and the network drops and comes back so every connection is dialed again on the moved clock; then the tab mints a fresh Clerk token and lists the account's devices. The device's hub credential has no expiry.",
  boundMs: 30_000,
  async run(lab) {
    await forEachTab(lab, (tab) => tab.shiftClock(2 * 60 * 60 * 1000));
    lab.note("clocks moved two hours ahead");
    lab.network.down();
    await forEachTab(lab, (tab) => tab.setOffline(true));
    changeHost(lab);
    await sleep(10_000);
    lab.network.restore({ cut: true });
    await forEachTab(lab, (tab) => tab.setOffline(false));
    const restored = Date.now();
    await forEachTab(lab, async (tab) => {
      const fresh = await tab.page.evaluate(async () => {
        const session = window.Clerk?.session;
        if (session == null) return false;
        const token = await session.getToken({ skipCache: true });
        const devices = await window.api.account.listDevices();
        return token !== null && token.length > 0 && devices.length > 0;
      });
      if (!fresh) throw new Error(`${tab.name} could not mint a fresh token`);
    });
    lab.note("fresh Clerk tokens minted and the device list read");
    await forEachTab(lab, (tab) => tab.shiftClock(0));
    return restored;
  },
};

const signOutWithSibling: Scenario = {
  name: "sign-out-with-sibling",
  does: "A second tab of the profile is opened, and the first signs out of the account while the browser's Clerk session stays (the account layer's sign-out, which the Sign out button runs when the tab's Clerk holds no session): within the bound both tabs read signed out and stay so for 30 s with no enrollment sent from either, and the host's device list no longer names the browser.",
  boundMs: 20_000,
  destructive: true,
  async run(lab) {
    const [first] = lab.tabs;
    if (first === undefined) throw new Error("no tab");
    const second = await lab.openTab();
    await recovered(lab, Date.now(), 30_000);
    const enrolls: string[] = [];
    for (const tab of lab.tabs) {
      tab.page.on("request", (request) => {
        if (
          request.method() === "POST" &&
          request.url().endsWith("/devices/enroll")
        ) {
          enrolls.push(tab.name);
          lab.note(`${tab.name} sent an enrollment`, "error");
        }
      });
    }
    const deviceId = await first.page.evaluate(() => window.api.deviceId);
    // The account layer's own sign-out, which is what the Sign out
    // button runs when the tab's Clerk holds no session, and what the
    // lab's cleanup runs: the browser's Clerk session stays, so the
    // sibling still holds it.
    lab.note(
      `signing ${first.name} out of the account, the Clerk session kept`,
    );
    await first.page.evaluate(() => window.api.account.signOut());
    const pressed = Date.now();
    await waitUntil(
      "both tabs to read signed out",
      async () => (await signedOut(first)) && (await signedOut(second)),
      this.boundMs,
    );
    lab.note(`both tabs signed out after ${Date.now() - pressed} ms`);
    await sleep(30_000);
    for (const tab of [first, second]) {
      if (!(await signedOut(tab)))
        throw new Error(`${tab.name} is signed in again`);
    }
    if (enrolls.length > 0) {
      throw new Error(`enrolled again from ${enrolls.join(", ")}`);
    }
    const listed = await lab.hostEval(() => window.api.account.listDevices());
    if (listed.some((device) => device.deviceId === deviceId)) {
      throw new Error("the host still lists the browser");
    }
    lab.note(
      "the profile stayed signed out and the browser is off the account",
    );
    return pressed;
  },
};

async function signedOut(tab: Tab): Promise<boolean> {
  return !(await tab.page.evaluate(() => window.api.account.status())).signedIn;
}

async function waitUntil(
  what: string,
  check: () => Promise<boolean>,
  ms: number,
) {
  const until = Date.now() + ms;
  while (!(await check().catch(() => false))) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(250);
  }
}

export const SOAK_SCENARIOS: readonly Scenario[] = [
  networkDrop,
  networkBlip,
  hubRedeploy,
  hostKill,
  appRelaunch,
  tabSleep,
  reloadAndSecondTab,
  twoTabsRedial,
  tokenExpiry,
];

export const ALL_SCENARIOS: readonly Scenario[] = [
  ...SOAK_SCENARIOS,
  signOutWithSibling,
];

// Whether this checkout's hub is the one on release/v3, so a redeploy
// puts back what the dev hub already runs.
export function hubMatchesRelease(): boolean {
  try {
    execFileSync(
      "git",
      [
        "diff",
        "--quiet",
        "origin/release/v3",
        "--",
        "hub",
        "packages/contracts",
      ],
      { cwd: repoDir },
    );
    return true;
  } catch {
    return false;
  }
}
