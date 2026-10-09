// The fake host's fixture world: one account, four devices, forests shaped
// after the owner's v2 flow mockups: Studio Mac local, Thinkpad online
// with a direct session, Mini and Work PC offline. Pure data, served
// over fixture transports by the bridge (bridge.ts).
import type * as Types from "effect/Types";
import type { DeviceInfo } from "@shigomori/contracts/hubProtocol";
import type {
  CommitSummary,
  CustomPort,
  Project,
  ProjectIcon,
  Release,
  RunningScript,
  Worktree,
} from "@shigomori/contracts/schemas";

export const FAKE_ACCOUNT_ID = "user_2rin8xk3";
export const FAKE_APP_VERSION = "2.0.3";

export const LOCAL_DEVICE_ID = "dev_8f3ac2e1";
export const THINKPAD_ID = "dev_1c94b0da";
export const MINI_ID = "dev_5b0e77aa";
export const WORKPC_ID = "dev_a02f61c3";

const now = Date.now();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// Stand-in project icons: a rounded tile with the repo's initial, so
// the surfaces that draw project icons (sidebar headers, the device
// chips on /account) show one without a real repo behind them. Keyed by
// name, so the same repo wears the same icon on every device. t3code is
// left out on purpose to pose the generated tile beside the others.
const ICON_HUE: Record<string, number> = {
  "shigoto-no-mori": 155,
  "port-pool": 235,
  dotfiles: 30,
};

export function projectIconFor(name: string): ProjectIcon | null {
  const hue = ICON_HUE[name];
  if (hue === undefined) return null;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="oklch(0.68 0.14 ${hue})"/><text x="16" y="22" text-anchor="middle" font-family="ui-sans-serif,system-ui,sans-serif" font-size="18" font-weight="700" fill="#fff">${name[0]?.toUpperCase() ?? ""}</text></svg>`;
  return { mime: "image/svg+xml", base64: btoa(svg) };
}

// Stand-in GitHub About text, keyed by name like the icons. port-pool's
// runs past the tile's two lines, and dotfiles is left out to pose a
// tile whose repo has none.
const REPO_DESCRIPTION: Record<string, string> = {
  "shigoto-no-mori":
    "A desktop app for managing many git worktrees in parallel.",
  "port-pool":
    "Hands out free ports to each worktree's dev servers, so several checkouts of one app can run side by side without fighting over 3000, and keeps the leases in a pool shared by every tool on the machine.",
  t3code: "A minimal web GUI for coding agents.",
};

export function repoDescriptionFor(name: string): string | null {
  return REPO_DESCRIPTION[name] ?? null;
}

// Mutable: a rename or icon pick for a peer lands on its entry here.
export const accountDevices: Types.Mutable<DeviceInfo>[] = [
  {
    deviceId: LOCAL_DEVICE_ID,
    name: "Studio Mac",
    platform: "darwin",
    icon: "mini",
    createdAt: now - 17 * DAY,
    lastSeenAt: now,
    online: true,
  },
  {
    deviceId: THINKPAD_ID,
    name: "Thinkpad",
    platform: "linux",
    icon: "laptop",
    createdAt: now - 16 * DAY,
    lastSeenAt: now,
    online: true,
  },
  {
    deviceId: MINI_ID,
    name: "Mini",
    platform: "darwin",
    icon: "mini",
    createdAt: now - 12 * DAY,
    lastSeenAt: now - 3 * HOUR,
    online: false,
  },
  {
    deviceId: WORKPC_ID,
    name: "Work PC",
    platform: "win32",
    icon: "desktop",
    createdAt: now - 9 * DAY,
    lastSeenAt: now - 6 * DAY,
    online: false,
  },
];

const iso = (msAgo: number) => new Date(now - msAgo).toISOString();

function commit(
  hash: string,
  subject: string,
  msAgo: number,
  additions = 24,
  deletions = 6,
): CommitSummary {
  return {
    hash,
    subject,
    author: "sylophi",
    date: iso(msAgo),
    additions,
    deletions,
  };
}

// A row of the fake forest, which the bridge's verbs update in place.
export type FakeWorktree = Types.Mutable<Worktree>;

// Every field WorktreeSchema requires, with quiet defaults. Overrides
// pose the interesting states.
export function worktree(
  base: Pick<Worktree, "id" | "projectId" | "name" | "branch" | "path"> &
    Partial<Worktree>,
): FakeWorktree {
  return {
    ahead: 0,
    behind: 0,
    hasUpstream: true,
    hasRemote: true,
    divergedClean: false,
    behindPrimary: 0,
    unpushedCount: 0,
    mergedIntoPrimary: false,
    changedCount: 0,
    recentCommits: [],
    isPrimary: false,
    isExternal: false,
    detached: false,
    shelved: false,
    autoPull: false,
    agentWorking: false,
    agentSessions: [],
    ...base,
  };
}

export type DeviceForest = {
  deviceId: string;
  projects: Project[];
  worktrees: Record<string, FakeWorktree[]>;
  // Whether this device accepts commands from the account's other
  // devices (its HubStatus.peerAcceptsCommands entry), so this page
  // may mutate it.
  grantsCaller: boolean;
};

const SM_IDENTITY = "root:4f2c9d1e7b0a86d3";
const PP_IDENTITY = "root:9a71b3c05e46f812";
const DF_IDENTITY = "root:c3d8e5f2a1904b76";

// ---- Studio Mac (the local device) ----

const localProjects: Project[] = [
  {
    id: "p_sm",
    name: "shigoto-no-mori",
    path: "/Users/rin/dev/shigoto-no-mori",
    pathExists: true,
    identity: SM_IDENTITY,
    remote: "github.com/sylophi/shigoto-no-mori",
    lastUsed: now - 14 * 60_000,
    recentCount: 32,
  },
  {
    id: "p_pp",
    name: "port-pool",
    path: "/Users/rin/dev/port-pool",
    pathExists: true,
    identity: PP_IDENTITY,
    remote: "github.com/sylophi/port-pool",
    lastUsed: now - 2 * DAY,
    recentCount: 6,
  },
  {
    id: "p_t3",
    name: "t3code",
    path: "/Users/rin/dev/t3code",
    pathExists: true,
    identity: null,
    remote: "github.com/pingdotgg/t3code",
    // Listed by terrier, not this app's registry, like dotfiles on the
    // Thinkpad: the rows Mark terrier projects tags.
    source: "terrier",
    lastUsed: now - 5 * DAY,
    recentCount: 2,
  },
];

const localWorktrees: Record<string, FakeWorktree[]> = {
  p_sm: [
    worktree({
      id: "wt_sm_main",
      projectId: "p_sm",
      name: "shigoto-no-mori",
      branch: "main",
      path: "/Users/rin/dev/shigoto-no-mori",
      isPrimary: true,
      recentCommits: [
        commit(
          "a91f3c7",
          "Draw the port-forward chip on the worktree detail",
          3 * HOUR,
          61,
          8,
        ),
        commit(
          "4d20b18",
          "Keep script runs attached across daemon reconnects",
          26 * HOUR,
          118,
          40,
        ),
      ],
    }),
    worktree({
      id: "wt_sm_hum",
      projectId: "p_sm",
      name: "happy-hummingbird",
      branch: "v2-exp/remote-ui-flows",
      // Its PR (#148) has taken this over, title and description both.
      title: "Remote UI flows",
      description: "The local description the PR replaced.",
      path: "/Users/rin/.sm/worktrees/shigoto-no-mori/happy-hummingbird",
      createdAt: now - 4 * DAY,
      ahead: 2,
      changedCount: 3,
      lastChangeAt: now - 14 * 60_000,
      recentCommits: [
        commit(
          "e7c0a52",
          "Badge merged projects with their devices",
          14 * 60_000,
          84,
          12,
        ),
        commit(
          "7d02b18",
          "Aggregate worktrees across daemons",
          1 * HOUR,
          132,
          57,
        ),
      ],
    }),
    worktree({
      id: "wt_sm_badger",
      projectId: "p_sm",
      name: "brave-badger",
      branch: "fix-stale-locks",
      path: "/Users/rin/.sm/worktrees/shigoto-no-mori/brave-badger",
      createdAt: now - 1 * DAY,
      agentWorking: true,
      agentSessions: [
        {
          harness: "claude",
          session: "4f2d8a61-0c3e-4b7a-9e55-2b1f6d0a7c93",
          state: "working",
          at: now - 6 * 60_000,
          title: "Fix the stale lock files the daemon leaves after a crash",
        },
      ],
      ahead: 2,
      lastChangeAt: now - 5 * HOUR,
      recentCommits: [
        commit(
          "b3319de",
          "Refuse a lock file older than the daemon",
          5 * HOUR,
          22,
          3,
        ),
      ],
    }),
    worktree({
      id: "wt_sm_quail",
      projectId: "p_sm",
      name: "quiet-quail",
      branch: "port-pool-retry",
      path: "/Users/rin/.sm/worktrees/shigoto-no-mori/quiet-quail",
      createdAt: now - 10 * DAY,
      agentSessions: [
        {
          harness: "codex",
          session: "01a11cac-636e-7453-a8bb-1b3a3f50418d",
          state: "waiting",
          at: now - 2 * 60_000,
          title: "Retry port-pool provisioning when a port is taken",
          tool: "Bash",
          need: "pnpm test port-pool",
        },
        {
          harness: "claude",
          session: "9b7e1d04-55aa-4c61-8f2e-d3c0b6a1e872",
          state: "idle",
          at: now - 3 * HOUR,
          title: "Which retry backoff should port-pool use?",
          message:
            "Retries now back off from 100ms up to 2s, and the provision test covers a port taken twice in a row. Opened PR #212.",
        },
      ],
      behindPrimary: 3,
      primaryRef: "origin/main",
      lastChangeAt: now - 2 * DAY,
      recentCommits: [
        commit(
          "91c4e2f",
          "Retry the pool lease before giving up",
          2 * DAY,
          17,
          5,
        ),
      ],
    }),
    worktree({
      id: "wt_sm_owl",
      projectId: "p_sm",
      name: "odd-owl",
      branch: "exp/tray-menu",
      title: "A tray menu for the forest",
      description: "Sketching what a menu bar icon could open.",
      path: "/Users/rin/.sm/worktrees/shigoto-no-mori/odd-owl",
      createdAt: now - 12 * DAY,
      shelved: true,
      ahead: 1,
      lastChangeAt: now - 9 * DAY,
      recentCommits: [
        commit("2e8b7c4", "Sketch a tray menu for the forest", 9 * DAY, 48, 0),
      ],
    }),
  ],
  p_pp: [
    worktree({
      id: "wt_pp_main",
      projectId: "p_pp",
      name: "port-pool",
      branch: "main",
      path: "/Users/rin/dev/port-pool",
      isPrimary: true,
      recentCommits: [
        commit("f00dc0d", "Release leases on SIGTERM", 3 * DAY, 9, 2),
      ],
    }),
    worktree({
      id: "wt_pp_marmot",
      projectId: "p_pp",
      name: "merry-marmot",
      branch: "lease-ttl",
      path: "/Users/rin/.sm/worktrees/port-pool/merry-marmot",
      behind: 1,
      // A title and description from `sm describe`, and no PR yet: the
      // sidebar names it by the title, and the page's description is
      // long enough to fold.
      title: "Expire port leases after a TTL",
      description: [
        "Leases a crashed process held stay taken until someone runs `port-pool release` by hand. This gives every lease a time to live and sweeps the expired ones.",
        "",
        "- A lease records when it was taken and how long it lives (default 24h, `--ttl` to change it).",
        "- `provision` renews the lease it finds for the same worktree instead of minting another.",
        "- The sweep runs before every provision, so nothing needs a daemon.",
        "",
        "## Still to do",
        "",
        "- Decide whether a lease held by a live pid outlives its TTL.",
        "- Document the sweep in the README.",
      ].join("\n"),
      recentCommits: [
        commit("0451ab9", "Expire leases with a TTL sweep", 2 * DAY, 40, 11),
      ],
    }),
  ],
  p_t3: [
    worktree({
      id: "wt_t3_main",
      projectId: "p_t3",
      name: "t3code",
      branch: "main",
      path: "/Users/rin/dev/t3code",
      isPrimary: true,
      recentCommits: [
        commit("77aa210", "Vendor the hub protocol notes", 6 * DAY, 5, 0),
      ],
    }),
  ],
};

// ---- Thinkpad (online, direct session up) ----

const thinkpadProjects: Project[] = [
  {
    id: "tp_sm",
    name: "shigoto-no-mori",
    path: "/home/rin/dev/shigoto-no-mori",
    pathExists: true,
    identity: SM_IDENTITY,
    remote: "github.com/sylophi/shigoto-no-mori",
    lastUsed: now - 40 * 60_000,
    recentCount: 11,
  },
  {
    id: "tp_df",
    name: "dotfiles",
    path: "/home/rin/dotfiles",
    pathExists: true,
    identity: DF_IDENTITY,
    remote: "github.com/rin/dotfiles",
    source: "terrier",
    lastUsed: now - 3 * DAY,
    recentCount: 3,
  },
];

const thinkpadWorktrees: Record<string, FakeWorktree[]> = {
  tp_sm: [
    worktree({
      id: "aa11bb22cc33",
      projectId: "tp_sm",
      name: "shigoto-no-mori",
      branch: "main",
      path: "/home/rin/dev/shigoto-no-mori",
      isPrimary: true,
      recentCommits: [
        commit(
          "a91f3c7",
          "Draw the port-forward chip on the worktree detail",
          3 * HOUR,
          61,
          8,
        ),
      ],
    }),
    worktree({
      id: "a1b2c3d4e5f6",
      projectId: "tp_sm",
      name: "gentle-gecko",
      branch: "exp/terrier-sync",
      path: "/home/rin/.sm/worktrees/shigoto-no-mori/gentle-gecko",
      createdAt: now - 2 * HOUR,
      ahead: 1,
      changedCount: 7,
      lastChangeAt: now - 40 * 60_000,
      recentCommits: [
        commit(
          "58c21fe",
          "Watch the terrier registry for edits",
          40 * 60_000,
          74,
          20,
        ),
      ],
    }),
    worktree({
      id: "c0ffee123456",
      projectId: "tp_sm",
      name: "patient-panda",
      branch: "exp/wayland-tray",
      path: "/home/rin/.sm/worktrees/shigoto-no-mori/patient-panda",
      createdAt: now - 8 * DAY,
      shelved: true,
      changedCount: 2,
      lastChangeAt: now - 6 * DAY,
      recentCommits: [
        commit("9d41a07", "Probe the Wayland tray protocol", 6 * DAY, 31, 4),
      ],
    }),
  ],
  tp_df: [
    worktree({
      id: "dd44ee55ff66",
      projectId: "tp_df",
      name: "dotfiles",
      branch: "main",
      path: "/home/rin/dotfiles",
      isPrimary: true,
      hasUpstream: true,
      recentCommits: [
        commit("31337af", "Alias sm to the dev build", 3 * DAY, 2, 1),
      ],
    }),
  ],
};

// ---- Mini (offline, but the forest exists so the fake host can pose "cached
// snapshot" and reconnect states by flipping it online) ----

const miniProjects: Project[] = [
  {
    id: "mini_sm",
    name: "shigoto-no-mori",
    path: "/Users/rin/dev/shigoto-no-mori",
    pathExists: true,
    identity: SM_IDENTITY,
    remote: "github.com/sylophi/shigoto-no-mori",
    lastUsed: now - 3 * HOUR,
    recentCount: 4,
  },
];

const miniWorktrees: Record<string, FakeWorktree[]> = {
  mini_sm: [
    worktree({
      id: "0123456789ab",
      projectId: "mini_sm",
      name: "shigoto-no-mori",
      branch: "main",
      path: "/Users/rin/dev/shigoto-no-mori",
      isPrimary: true,
      recentCommits: [],
    }),
    worktree({
      id: "ba9876543210",
      projectId: "mini_sm",
      name: "nimble-newt",
      branch: "quiet-quail/notes",
      path: "/Users/rin/.sm/worktrees/shigoto-no-mori/nimble-newt",
      changedCount: 7,
      ahead: 1,
      lastChangeAt: now - 3 * HOUR,
      recentCommits: [
        commit("6f0a3d1", "Note the pool retry follow-ups", 3 * HOUR, 12, 0),
      ],
    }),
  ],
};

// A disk per device for the add-project flow to browse: home folder,
// then every folder it can list, keyed by absolute path. A registered
// project's folder is a git repo here too, and each machine has a repo
// or two it never registered, so a scan finds something. The Thinkpad
// has no port-pool, which is what cloning one onto it is posed with.
export type FakeDisk = {
  home: string;
  dirs: Record<string, { name: string; isGitRepo: boolean }[]>;
};

const dir = (name: string) => ({ name, isGitRepo: false });
const repo = (name: string) => ({ name, isGitRepo: true });

export const fakeDisks: Record<string, FakeDisk> = {
  [LOCAL_DEVICE_ID]: {
    home: "/Users/rin",
    dirs: {
      "/Users/rin": [dir("Documents"), dir("Downloads"), dir("dev")],
      "/Users/rin/Documents": [],
      "/Users/rin/Downloads": [],
      "/Users/rin/dev": [
        repo("hub-worker"),
        repo("port-pool"),
        dir("sandbox"),
        repo("shigoto-no-mori"),
        repo("t3code"),
      ],
      "/Users/rin/dev/sandbox": [repo("advent-2025")],
    },
  },
  [THINKPAD_ID]: {
    home: "/home/rin",
    dirs: {
      "/home/rin": [
        dir("Downloads"),
        dir("dev"),
        repo("dotfiles"),
        dir("notes"),
      ],
      "/home/rin/Downloads": [],
      "/home/rin/notes": [],
      "/home/rin/dev": [
        repo("blog"),
        dir("experiments"),
        repo("shigoto-no-mori"),
      ],
      "/home/rin/dev/experiments": [repo("zig-raytracer")],
    },
  },
  [MINI_ID]: {
    home: "/Users/rin",
    dirs: {
      "/Users/rin": [dir("dev")],
      "/Users/rin/dev": [repo("shigoto-no-mori")],
    },
  },
  [WORKPC_ID]: { home: "/home/rin", dirs: { "/home/rin": [] } },
};

// The remote each fixture repo was cloned from, by repo identity (the
// one thing a repo's checkouts share across devices). A clone of one
// lands with that identity, so it folds into the sidebar group the
// other devices' checkouts already sit in.
export const fakeRemoteUrls: Record<string, string> = {
  [SM_IDENTITY]: "git@github.com:sylophi/shigoto-no-mori.git",
  [PP_IDENTITY]: "git@github.com:sylophi/port-pool.git",
  [DF_IDENTITY]: "git@github.com:rin/dotfiles.git",
};

export const forests: Record<string, DeviceForest> = {
  [LOCAL_DEVICE_ID]: {
    deviceId: LOCAL_DEVICE_ID,
    projects: localProjects,
    worktrees: localWorktrees,
    grantsCaller: true,
  },
  [THINKPAD_ID]: {
    deviceId: THINKPAD_ID,
    projects: thinkpadProjects,
    worktrees: thinkpadWorktrees,
    grantsCaller: true,
  },
  [MINI_ID]: {
    deviceId: MINI_ID,
    projects: miniProjects,
    worktrees: miniWorktrees,
    grantsCaller: false,
  },
  [WORKPC_ID]: {
    deviceId: WORKPC_ID,
    projects: [],
    worktrees: {},
    grantsCaller: false,
  },
};

export const fakeGlobalConfig = {
  launchScripts: true,
  deleteBranchOnRemove: true,
  autoPopulateInstall: true,
  autoPullNew: false,
  autoPullPrimaryOnly: false,
  // A fresh install's seed: names on, Village life unset (off).
  doubutsuNames: true,
  codexWorktreeNames: false,
  managedOnProjectDrive: false,
  portPool: true,
  terrier: true,
  githubCli: true,
  directConnections: true,
};

// ---- ports ----

// port-pool's allocations by worktree id, in the project's declared
// order, and the user-added ports (what the worktree data file holds).
// Which numbers have a server behind them is a flat set: the fake host poses
// liveness, it does not run servers.
export const fakePoolPorts: Record<string, { name: string; port: number }[]> = {
  wt_sm_badger: [{ name: "renderer", port: 5731 }],
  wt_sm_hum: [{ name: "renderer", port: 5741 }],
  aa11bb22cc33: [{ name: "renderer", port: 5174 }],
  ba9876543210: [
    { name: "renderer", port: 5182 },
    { name: "api", port: 5183 },
  ],
  a1b2c3d4e5f6: [
    { name: "renderer", port: 5173 },
    { name: "storybook", port: 6006 },
  ],
};

export const fakeCustomPorts: Record<string, CustomPort[]> = {
  wt_sm_badger: [{ port: 5732, label: "api" }],
  a1b2c3d4e5f6: [{ port: 8787, label: "api" }, { port: 5555 }],
};

export const fakeListeningPorts = new Set([5731, 5173, 6006, 8787, 5182]);

// The scripts each device runs right now, as scripts:list answers (the
// Live page). The dev servers behind the listening ports above, and a
// setup still going on Thinkpad. Stopping one drops it here.
const minutesAgo = (minutes: number) => Date.now() - minutes * 60_000;
export const fakeRunningScripts: Record<string, RunningScript[]> = {
  [LOCAL_DEVICE_ID]: [
    {
      runId: "run-sm-badger-dev",
      projectId: "p_sm",
      worktreeId: "wt_sm_badger",
      slot: { kind: "package", name: "dev" },
      startedAt: minutesAgo(52),
      interactive: true,
    },
    {
      runId: "run-sm-hum-storybook",
      projectId: "p_sm",
      worktreeId: "wt_sm_hum",
      slot: { kind: "package", name: "fake-host" },
      startedAt: minutesAgo(7),
      interactive: true,
    },
  ],
  [THINKPAD_ID]: [
    {
      runId: "run-tp-gecko-dev",
      projectId: "tp_sm",
      worktreeId: "a1b2c3d4e5f6",
      slot: { kind: "package", name: "dev" },
      startedAt: minutesAgo(180),
      interactive: true,
    },
    {
      runId: "run-tp-panda-setup",
      projectId: "tp_sm",
      worktreeId: "c0ffee123456",
      slot: { kind: "setup" },
      startedAt: minutesAgo(1),
      interactive: false,
    },
  ],
};

// ?liveEdge=1: the Live page's hard cases on top of the runs above. A
// script name too long for its line, a worktree running five things,
// a run in a worktree its device no longer lists, and a run on Mini,
// which takes no commands from here (pair with mini:connected).
const pkg = (name: string) => ({ kind: "package" as const, name });

export function addLiveEdgeRuns(): void {
  fakeRunningScripts[LOCAL_DEVICE_ID]?.push(
    {
      runId: "edge-long",
      projectId: "p_sm",
      worktreeId: "wt_sm_hum",
      slot: pkg("storybook:watch-with-every-addon-and-a-very-long-name"),
      startedAt: minutesAgo(3 * 24 * 60),
      interactive: true,
    },
    ...["dev", "test:watch", "typecheck:watch", "lint:watch"].map(
      (name, index) => ({
        runId: `edge-quail-${index}`,
        projectId: "p_sm",
        worktreeId: "wt_sm_quail",
        slot: pkg(name),
        startedAt: minutesAgo(90 + index),
        interactive: true,
      }),
    ),
    {
      runId: "edge-quail-teardown",
      projectId: "p_sm",
      worktreeId: "wt_sm_quail",
      slot: { kind: "teardown" },
      startedAt: minutesAgo(0),
      interactive: false,
    },
    {
      runId: "edge-gone",
      projectId: "p_sm",
      worktreeId: "wt_sm_gone00",
      slot: pkg("dev"),
      startedAt: minutesAgo(400),
      interactive: true,
    },
  );
  fakeRunningScripts[MINI_ID] = [
    {
      runId: "edge-mini",
      projectId: "mini_sm",
      worktreeId: "ba9876543210",
      slot: pkg("dev"),
      startedAt: minutesAgo(25),
      interactive: true,
    },
  ];
}

// ---- releases ----

// The changelog's GitHub releases, newest first as the API lists
// them: the staged 2.1.0 (?updates) with a screenshot, a beta that
// only a device on a prerelease sees, the fake host's own 2.0.3, and two
// before it. The notes follow the real ones' shape.
const RELEASES_URL = "https://github.com/sylophi/shigoto-no-mori/releases/tag";

export const fakeReleases: Release[] = [
  {
    version: "2.1.0",
    notes: [
      "This release lets you do a lot more from ⌘K and lets PRs merge themselves once they're ready.",
      "",
      "**Do more from ⌘K** ([#417](https://github.com/sylophi/shigoto-no-mori/pull/417))",
      "Next to the list, a new pane shows what you can do with the highlighted worktree: open it, see its changes or PR, launch tools, push or pull, run scripts, or copy its path.",
      "",
      '<img alt="⌘K with its action pane" src="https://github.com/user-attachments/assets/4b5f3740-c9fa-4111-a11c-6fbe377aeff5" width="640">',
      "",
      "**Merge when ready** ([#423](https://github.com/sylophi/shigoto-no-mori/pull/423))",
      'On repos with auto-merge enabled, the button reads "Squash and merge when ready", and GitHub merges it once it can. `sm merge` and `sm land` do the same.',
      "",
      "**Smaller fixes**",
      "- In light mode, hover stripes now show up on settings rows. ([#425](https://github.com/sylophi/shigoto-no-mori/pull/425))",
      "- A device that's still connecting now shows amber, and an offline one shows gray. ([#419](https://github.com/sylophi/shigoto-no-mori/pull/419))",
      "",
      "**Full Changelog**: https://github.com/sylophi/shigoto-no-mori/compare/v2.0.3...v2.1.0",
    ].join("\n"),
    publishedAt: new Date(now - 2 * HOUR).toISOString(),
    prerelease: false,
    url: `${RELEASES_URL}/v2.1.0`,
  },
  {
    version: "2.1.0-beta.1",
    notes: "A first look at the new ⌘K pane.",
    publishedAt: new Date(now - 2 * DAY).toISOString(),
    prerelease: true,
    url: `${RELEASES_URL}/v2.1.0-beta.1`,
  },
  {
    version: "2.0.3",
    notes: [
      "**Toasts that match the theme** ([#422](https://github.com/sylophi/shigoto-no-mori/pull/422))",
      "Each one is tinted by its tone, with the theme's buttons and font.",
      "",
      "### Under the hood",
      "",
      "- The web client and UI lab dev servers get their own ports per worktree. ([#426](https://github.com/sylophi/shigoto-no-mori/pull/426))",
    ].join("\n"),
    publishedAt: new Date(now - 3 * DAY).toISOString(),
    prerelease: false,
    url: `${RELEASES_URL}/v2.0.3`,
  },
  {
    version: "2.0.2",
    notes:
      "- Village news cards dismiss with a click anywhere on them. ([#420](https://github.com/sylophi/shigoto-no-mori/pull/420))",
    publishedAt: new Date(now - 5 * DAY).toISOString(),
    prerelease: false,
    url: `${RELEASES_URL}/v2.0.2`,
  },
  {
    version: "2.0.1",
    notes:
      '- Release builds no longer report their commit as "dirty". ([#418](https://github.com/sylophi/shigoto-no-mori/pull/418))',
    publishedAt: new Date(now - 6 * DAY).toISOString(),
    prerelease: false,
    url: `${RELEASES_URL}/v2.0.1`,
  },
];
