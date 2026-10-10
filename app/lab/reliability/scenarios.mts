// The scenarios, and what recovering from one means for a client.
//
// A page (a browser tab, or a desktop app's window) has recovered when
// its hub socket is connected and its session to the host up, the
// host's indicator reads Connected, and the host's worktrees as listed
// through the hub and as drawn in the sidebar both match what the host
// itself says, with no uncaught error and no failed request the page's
// log says nothing about. The terminal has when `devices` names the
// host as connected and `list --remote` lists what the host says, both
// exiting 0. Each scenario changes the host's worktrees while the
// clients are cut off, so a view that did not catch up shows as stale.
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
  // How long the clients get to recover, from the moment the
  // disruption ends.
  readonly boundMs: number;
  // Runs the disruption and answers when it ended.
  readonly run: (lab: Lab, random: () => number) => Promise<number>;
  // Whether this lab's clients give it something to do.
  readonly applies?: (lab: Lab) => boolean;
  // Leaves the profile signed out, so it runs only when named, last,
  // and checks its own outcome rather than a recovery.
  readonly destructive?: boolean;
};

type PageState = {
  socket: string;
  session: boolean;
  indicator: boolean;
  listed: string[] | null;
  shown: string[] | null;
};

async function stateOf(lab: Lab, tab: Tab): Promise<PageState> {
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
  return { ...inPage, indicator: await showsConnected(lab, tab) };
}

async function showsConnected(lab: Lab, tab: Tab): Promise<boolean> {
  return (
    (await tab.page
      .getByRole("radio", { name: `${lab.host.label}, Connected`, exact: true })
      .count()) > 0
  );
}

// Opens the host's project in the sidebar's Projects layout, so its
// worktrees are drawn.
export async function showProject(lab: Lab, tab: Tab): Promise<void> {
  // A desktop window also lists its own device and every other on the
  // account, so it is narrowed to the host's worktrees.
  if (tab.app !== null) {
    const host = tab.page
      .getByRole("radiogroup", { name: "Show worktrees on" })
      .getByRole("radio", {
        name: new RegExp(`^${escapeRegExp(lab.host.label)}, `),
      });
    if ((await host.count()) > 0 && !(await host.first().isChecked())) {
      await host.first().click();
    }
  }
  const layout = tab.page.getByRole("radio", { name: "Projects", exact: true });
  if ((await layout.count()) > 0 && !(await layout.isChecked())) {
    await layout.click();
  }
  // A desktop window lists its own device's project of the same name
  // too: the host's is the one marked as on the host.
  const project = tab.page
    .locator("aside")
    .getByRole("button", { name: lab.host.projectName, exact: true });
  const count = await project.count();
  for (let i = 0; i < count; i++) {
    const each = project.nth(i);
    const onHost =
      (await each
        .locator(`[aria-label="On ${lab.host.label}"]`)
        .count()
        .catch(() => 0)) > 0;
    if (onHost || i === count - 1) {
      await each.click();
      return;
    }
  }
}

const escapeRegExp = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const same = (a: string[] | null, b: string[]) =>
  a !== null && JSON.stringify(a) === JSON.stringify(b);

// What still stands between a page and recovered, or null.
function unrecovered(state: PageState, expected: string[]): string | null {
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

type DevicesAnswer = {
  devices: Array<{ name: string; block?: string }>;
};

// What still stands between the terminal and recovered, or null.
async function terminalUnrecovered(
  lab: Lab,
  expected: string[],
): Promise<string | null> {
  const devices = await lab.terminal(["--json", "devices"], 20_000);
  if (devices.code !== 0) {
    return `devices exited ${devices.code}: ${firstLine(devices)}`;
  }
  const row = (JSON.parse(devices.stdout) as DevicesAnswer).devices.find(
    (device) => device.name === lab.host.label,
  );
  if (row === undefined) return "devices does not name the host";
  if ((row.block ?? "") !== "") return `devices says the host is ${row.block}`;
  const listed = await lab.terminal(
    ["--json", "worktrees", "list", "--remote", "--from", lab.host.deviceId],
    20_000,
  );
  if (listed.code !== 0) {
    return `list --remote exited ${listed.code}: ${firstLine(listed)}`;
  }
  const branches = (
    JSON.parse(listed.stdout) as Array<{ branch: string | null }>
  )
    .map((each) => each.branch ?? "")
    .toSorted();
  if (!same(branches, expected)) {
    return `list --remote shows ${JSON.stringify(branches)}, the host has ${JSON.stringify(expected)}`;
  }
  return null;
}

function firstLine(run: { stdout: string; stderr: string }): string {
  return ((run.stderr.trim() || run.stdout.trim()).split("\n")[0] ?? "").slice(
    0,
    200,
  );
}

// Waits for every client to recover, answering how long the slowest
// took from `since`, or throws with what was still wrong at the bound.
export async function recovered(
  lab: Lab,
  since: number,
  boundMs: number,
): Promise<number> {
  const expected = lab.hostBranches();
  const pending = new Map<Tab | "term", string>(
    lab.pages().map((tab) => [tab, "not checked yet"]),
  );
  if (lab.has("terminal")) pending.set("term", "not checked yet");
  // When each page was last asked to open the project, which a reload
  // closes, so its rows are drawn to compare.
  const opened = new Map<Tab, number>();
  let slowest = 0;
  while (pending.size > 0) {
    for (const client of pending.keys()) {
      let reason: string | null;
      try {
        if (client === "term") {
          reason = await terminalUnrecovered(lab, expected);
        } else {
          const state = await stateOf(lab, client);
          if (
            state.shown === null &&
            state.session &&
            Date.now() - (opened.get(client) ?? 0) > 3000
          ) {
            opened.set(client, Date.now());
            await showProject(lab, client);
          }
          reason = unrecovered(state, expected);
        }
      } catch (error) {
        reason = `it did not answer: ${String(error)}`;
      }
      if (reason === null) {
        pending.delete(client);
        slowest = Math.max(slowest, Date.now() - since);
      } else {
        pending.set(client, reason);
      }
    }
    if (pending.size === 0) break;
    if (Date.now() - since > boundMs) {
      throw new Error(
        [...pending]
          .map(
            ([client, reason]) =>
              `${client === "term" ? "term" : client.name}: ${reason}`,
          )
          .join("; "),
      );
    }
    await sleep(250);
  }
  return slowest;
}

// The failures in a window of the trace that broke the rules: an
// uncaught error, or a page whose requests failed while it logged
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

// ---- changing the host while the clients cannot see it ----

let worktreeCount = 0;

// Adds a worktree on the host, and removes the oldest the harness made
// past three, so the list a recovered client shows has to be a new one.
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

async function forEachPage(lab: Lab, fn: (tab: Tab) => Promise<void>) {
  await Promise.all(lab.pages().map(fn));
}

// ---- the terminal during an outage and after ----

// What the terminal says while the host is out of reach: each verb
// must end within the bound, a refusal must exit non-zero in words
// that name the problem, and a send must leave the worktree where it
// was. Answers what broke those rules, for the scenario to fail on.
async function terminalDuringOutage(lab: Lab): Promise<string[]> {
  if (!lab.has("terminal")) return [];
  const broke: string[] = [];
  const BOUND_MS = 60_000;
  const check = (what: string, run: Awaited<ReturnType<Lab["terminal"]>>) => {
    if (run.code === null || run.ms > BOUND_MS) {
      broke.push(`${what} took ${run.ms} ms, past ${BOUND_MS / 1000} s`);
    } else if (run.code !== 0 && firstLine(run) === "") {
      broke.push(`${what} exited ${run.code} with no words`);
    } else if (run.code !== 0 && /\n\s+at /.test(run.stderr)) {
      broke.push(`${what} exited ${run.code} with a stack trace`);
    } else if (
      run.code !== 0 &&
      /An error occurred in |UnknownError/.test(firstLine(run))
    ) {
      broke.push(
        `${what} exited ${run.code} without its cause: ${firstLine(run)}`,
      );
    }
  };
  check("devices", await lab.terminal(["devices"], BOUND_MS + 5000));
  check(
    "list --remote",
    await lab.terminal(
      ["worktrees", "list", "--remote", "--from", lab.host.deviceId],
      BOUND_MS + 5000,
    ),
  );
  const name = `term-${Date.now().toString(36)}`;
  lab.smdRun(["worktrees", "create", name, "--no-cd"], lab.desk ?? undefined);
  const send = await lab.terminal(
    [
      "worktrees",
      "send",
      name,
      "--to",
      lab.host.deviceId,
      "--source",
      "teardown",
    ],
    BOUND_MS + 5000,
  );
  check("send", send);
  if (send.code === 0) {
    lab.note(`the send of ${name} landed during the outage`, "warning");
  } else {
    const stillHere = lab
      .smdJson<Array<{ name: string }>>(
        ["worktrees", "list", "--identities"],
        lab.desk ?? undefined,
      )
      .some((row) => row.name === name);
    if (!stillHere) broke.push(`the failed send took ${name} off A`);
    else lab.smdRun(["worktrees", "rm", name, "-f"], lab.desk ?? undefined);
  }
  return broke;
}

// A send to the host and the bring back, which a recovered link must
// carry: both exit 0, the worktree lands on the host and then back.
export async function terminalRoundTrip(lab: Lab): Promise<void> {
  if (!lab.has("terminal") || lab.desk === null) return;
  const name = `term-${Date.now().toString(36)}`;
  lab.smdRun(["worktrees", "create", name, "--no-cd"], lab.desk);
  const sent = await lab.terminal([
    "worktrees",
    "send",
    name,
    "--to",
    lab.host.deviceId,
    "--source",
    "teardown",
  ]);
  if (sent.code !== 0) {
    throw new Error(`send exited ${sent.code}: ${firstLine(sent)}`);
  }
  const brought = await lab.terminal([
    "worktrees",
    "bring",
    name,
    "--from",
    lab.host.deviceId,
    "--source",
    "teardown",
  ]);
  if (brought.code !== 0) {
    throw new Error(`bring exited ${brought.code}: ${firstLine(brought)}`);
  }
  const home = lab
    .smdJson<Array<{ name: string }>>(
      ["worktrees", "list", "--identities"],
      lab.desk,
    )
    .some((row) => row.name === name);
  if (!home) throw new Error(`${name} is not back on A after the bring`);
  lab.smdRun(["worktrees", "rm", name, "-f"], lab.desk);
  lab.note(`the terminal sent and brought back ${name}`);
}

// ---- the scenarios ----

// How long the browser tabs took to stop reading the host as Connected
// once the network went, which a browser that says it is offline has
// no reason to wait out. A desktop window has no such word from its
// host and learns it from the heartbeat, so its time is only noted.
async function outageShown(lab: Lab, boundMs: number): Promise<number> {
  const since = Date.now();
  await waitUntil(
    "every tab to stop showing the host as Connected while offline",
    async () => {
      for (const tab of lab.tabs) {
        if (await showsConnected(lab, tab)) return false;
      }
      return true;
    },
    boundMs,
  );
  return Date.now() - since;
}

// Notes when each desktop window stops reading the host as Connected,
// until `until`.
async function noteWindowsOutage(lab: Lab, since: number, until: number) {
  const pending = new Set(lab.windows);
  while (pending.size > 0 && Date.now() < until) {
    for (const tab of pending) {
      if (!(await showsConnected(lab, tab).catch(() => true))) {
        lab.note(
          `${tab.name} showed the outage after ${Date.now() - since} ms`,
        );
        pending.delete(tab);
      }
    }
    await sleep(500);
  }
  for (const tab of pending) {
    lab.note(
      `${tab.name} still read the host as Connected when it came back`,
      "warning",
    );
  }
}

const networkDrop: Scenario = {
  name: "network-drop",
  does: "The clients' network goes for 20 to 60 s (every flow stalls, new ones are refused, the pages report offline) and comes back changed: the stalled flows are cut. The terminal lists and sends meanwhile.",
  boundMs: 30_000,
  async run(lab, random) {
    const ms = between(random, 20_000, 60_000);
    lab.note(`network down for ${ms} ms`);
    const down = Date.now();
    lab.network.down();
    await forEachPage(lab, (tab) => tab.setOffline(true));
    changeHost(lab);
    const windows = noteWindowsOutage(lab, down, down + ms);
    const shown = await outageShown(lab, 10_000);
    lab.note(`the tabs showed the outage after ${shown} ms`);
    const broke = await terminalDuringOutage(lab);
    await windows;
    await sleep(Math.max(0, down + ms - Date.now()));
    lab.network.restore({ cut: true });
    await forEachPage(lab, (tab) => tab.setOffline(false));
    lab.note("network back, the old flows cut");
    if (broke.length > 0) throw new Error(broke.join("; "));
    return Date.now();
  },
};

const networkBlip: Scenario = {
  name: "network-blip",
  does: "Every flow stalls for 5 to 15 s and then resumes, with no offline event: a network that hiccups without the clients noticing.",
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
    // when none drops, the flows are cut, and every client dials the
    // new version, which is what a deploy has to survive.
    const dropped = await waitUntil(
      "a client to see the redeploy drop its hub socket",
      async () =>
        [
          ...lab.trace.filter((line) => line.at >= started),
          ...lab.devicesLogSince(started),
        ].some(
          (line) =>
            line.source !== "harness" &&
            /\[hub\] socket (backoff|connecting)/.test(line.text),
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
  does: "The host's process is killed (SIGKILL); its shell forks it again and every client has to find it.",
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
  does: "The host's whole dev app is quit (its launcher's process group signalled), the host changed meanwhile, and the app launched again.",
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

const laptopSleep: Scenario = {
  name: "laptop-sleep",
  does: "The clients' machine sleeps for 30 to 120 s (past a hub ticket's 60 s life about half the time): every tab hidden and frozen, the desktop apps stopped (SIGSTOP), the network gone; then the network comes back changed, the apps go on (SIGCONT), the pages' clocks jump by the time asleep and the tabs wake.",
  boundMs: 30_000,
  async run(lab, random) {
    const ms = between(random, 30_000, 120_000);
    lab.note(`asleep for ${ms} ms`);
    await Promise.all(lab.tabs.map((tab) => tab.setHidden(true)));
    await Promise.all(lab.tabs.map((tab) => tab.setFrozen(true)));
    const apps = [lab.desk, lab.remote].filter((app) => app !== null);
    const frozen = apps.map((app) => [app, app.freeze()] as const);
    lab.network.down();
    changeHost(lab);
    await sleep(ms);
    lab.network.restore({ cut: true });
    for (const [app, pids] of frozen) app.thaw(pids);
    await Promise.all(
      lab.windows.map((tab) => tab.shiftClock(ms).catch(() => {})),
    );
    await Promise.all(
      lab.tabs.map(async (tab) => {
        await tab.setFrozen(false);
        await tab.setOffline(false);
        await tab.setHidden(false);
      }),
    );
    lab.note("awake");
    return Date.now();
  },
};

const hostSleep: Scenario = {
  name: "host-sleep",
  does: "The host's machine sleeps for 30 to 120 s: its whole app stopped (SIGSTOP), cloudflared and all, so its sockets go silent without closing. The clients must stop showing it as Connected, then find it again once it goes on (SIGCONT). The terminal lists and sends meanwhile.",
  boundMs: 60_000,
  async run(lab, random) {
    const ms = between(random, 30_000, 120_000);
    lab.note(`the host asleep for ${ms} ms`);
    const asleep = Date.now();
    const pids = lab.hostApp.freeze();
    const shown = waitUntil(
      "every page to stop showing the host as Connected",
      async () => {
        for (const tab of lab.pages()) {
          if (await showsConnected(lab, tab)) return false;
        }
        return true;
      },
      ms,
    ).then(
      () =>
        lab.note(
          `every page showed the host gone after ${Date.now() - asleep} ms`,
        ),
      () =>
        lab.note(
          `some page still read the host as Connected after ${ms} ms asleep`,
          "warning",
        ),
    );
    const broke = await terminalDuringOutage(lab);
    await shown;
    await sleep(Math.max(0, asleep + ms - Date.now()));
    lab.hostApp.thaw(pids);
    lab.note("the host is awake");
    // The host changes once awake, since its own CLI waits on its store.
    changeHost(lab);
    if (broke.length > 0) throw new Error(broke.join("; "));
    return Date.now();
  },
};

const deskHostKill: Scenario = {
  name: "desk-host-kill",
  does: "The desktop device's own host process is killed (SIGKILL); its shell forks it again, and its windows and the terminal have to find it.",
  boundMs: 30_000,
  applies: (lab) => lab.desk !== null,
  async run(lab) {
    const pid = lab.desk?.hostPid() ?? null;
    if (pid === null) throw new Error("no desktop host process to kill");
    lab.note(`killing the desktop's host process ${pid}`);
    process.kill(pid, "SIGKILL");
    if (lab.has("terminal")) {
      const run = await lab.terminal(["devices"], 30_000);
      if (run.code !== 0 && firstLine(run) === "") {
        throw new Error(
          `devices exited ${run.code} with no words while A's host restarted`,
        );
      }
    }
    changeHost(lab);
    return Date.now();
  },
};

const reloadAndSecondTab: Scenario = {
  name: "reload-and-second-tab",
  does: "The first tab is reloaded and has to recover, then a second tab of the profile is opened and both have to hold, then the second closes and the first has to stay.",
  boundMs: 30_000,
  applies: (lab) => lab.tabs.length > 0,
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

const reloadAndThirdWindow: Scenario = {
  name: "reload-and-third-window",
  does: "The desktop's first window is reloaded and has to recover, then a third window opened (New Window) and all have to hold, then it closes and the other two have to stay.",
  boundMs: 30_000,
  applies: (lab) => lab.desk !== null && lab.has("desktop"),
  async run(lab) {
    const app = lab.desk;
    const first = lab.windows.find((tab) => tab.app === app);
    if (app === null || first === undefined) throw new Error("no window");
    changeHost(lab);
    lab.note(`reloading ${first.name}`);
    await first.page.reload();
    await first.page.evaluate(() => undefined);
    await recovered(lab, Date.now(), 30_000);
    const third = await lab.openWindow(app, "desk");
    lab.note(`opened ${third.name}`);
    await recovered(lab, Date.now(), 30_000);
    await lab.closeWindow(third);
    lab.note(`closed ${third.name}`);
    changeHost(lab);
    return Date.now();
  },
};

const tokenExpiry: Scenario = {
  name: "token-expiry",
  does: "Every page's wall clock jumps two hours ahead, past the Clerk session token's minute and a hub ticket's minute, and the network drops and comes back so every connection is dialed again on the moved clock; then each page mints a fresh Clerk token and lists the account's devices. The device's hub credential has no expiry.",
  boundMs: 30_000,
  async run(lab) {
    await forEachPage(lab, (tab) => tab.shiftClock(2 * 60 * 60 * 1000));
    lab.note("clocks moved two hours ahead");
    lab.network.down();
    await forEachPage(lab, (tab) => tab.setOffline(true));
    changeHost(lab);
    await sleep(10_000);
    lab.network.restore({ cut: true });
    await forEachPage(lab, (tab) => tab.setOffline(false));
    const restored = Date.now();
    await forEachPage(lab, async (tab) => {
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
    await forEachPage(lab, (tab) => tab.shiftClock(0));
    return restored;
  },
};

const signOutWithSibling: Scenario = {
  name: "sign-out-with-sibling",
  does: "A second tab of the profile is opened, and the first signs out of the account while the browser's Clerk session stays (the account layer's sign-out, which the Sign out button runs when the tab's Clerk holds no session): within the bound both tabs read signed out and stay so for 30 s with no enrollment sent from either, and the host's device list no longer names the browser.",
  boundMs: 20_000,
  destructive: true,
  applies: (lab) => lab.tabs.length > 0,
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
  laptopSleep,
  hostSleep,
  deskHostKill,
  reloadAndSecondTab,
  reloadAndThirdWindow,
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
