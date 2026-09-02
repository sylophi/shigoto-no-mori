// The lab's fixture world: one account, four devices, forests shaped
// after the owner's v2 flow mockups: Studio Mac local, Thinkpad online
// with a direct session, Mini and Work PC offline. Pure data, served
// over fixture transports by the bridge (lab/bridge.ts).
import type { DeviceInfo } from "@shared/relay/protocol";
import type {
  CommitSummary,
  CustomPort,
  Project,
  ProjectIcon,
  Worktree,
} from "@shared/schemas";

export const LAB_ACCOUNT_ID = "user_2rin8xk3";
export const LAB_APP_VERSION = "2.0.3";

export const LOCAL_DEVICE_ID = "dev_8f3ac2e1";
export const THINKPAD_ID = "dev_1c94b0da";
export const MINI_ID = "dev_5b0e77aa";
export const WORKPC_ID = "dev_a02f61c3";

const now = Date.now();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// Lab-only project icons: a rounded tile with the repo's initial, so
// the surfaces that draw project icons (sidebar headers, the device
// chips on /devices) show one without a real repo behind them. Keyed by
// name, so the same repo wears the same icon on every device. t3code is
// left out on purpose to pose the icon-less case beside the others.
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

export const accountDevices: DeviceInfo[] = [
  {
    deviceId: LOCAL_DEVICE_ID,
    name: "Studio Mac",
    platform: "darwin",
    createdAt: now - 17 * DAY,
    lastSeenAt: now,
    online: true,
  },
  {
    deviceId: THINKPAD_ID,
    name: "Thinkpad",
    platform: "linux",
    createdAt: now - 16 * DAY,
    lastSeenAt: now,
    online: true,
  },
  {
    deviceId: MINI_ID,
    name: "Mini",
    platform: "darwin",
    createdAt: now - 12 * DAY,
    lastSeenAt: now - 3 * HOUR,
    online: false,
  },
  {
    deviceId: WORKPC_ID,
    name: "Work PC",
    platform: "win32",
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

// Every field WorktreeSchema requires, with quiet defaults. Overrides
// pose the interesting states.
function worktree(
  base: Pick<Worktree, "id" | "projectId" | "name" | "branch" | "path"> &
    Partial<Worktree>,
): Worktree {
  return {
    ahead: 0,
    behind: 0,
    hasUpstream: true,
    hasRemote: true,
    divergedClean: false,
    behindPrimary: 0,
    mergedIntoPrimary: false,
    changedCount: 0,
    recentCommits: [],
    isPrimary: false,
    isExternal: false,
    detached: false,
    shelved: false,
    ...base,
  };
}

export type DeviceForest = {
  deviceId: string;
  projects: Project[];
  worktrees: Record<string, Worktree[]>;
  // What remoteAccess:commandAccess answers CALLERS (i.e. whether the
  // local lab client may mutate this device).
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
    lastUsed: now - 14 * 60_000,
    recentCount: 32,
  },
  {
    id: "p_pp",
    name: "port-pool",
    path: "/Users/rin/dev/port-pool",
    pathExists: true,
    identity: PP_IDENTITY,
    lastUsed: now - 2 * DAY,
    recentCount: 6,
  },
  {
    id: "p_t3",
    name: "t3code",
    path: "/Users/rin/dev/t3code",
    pathExists: true,
    identity: null,
    lastUsed: now - 5 * DAY,
    recentCount: 2,
  },
];

const localWorktrees: Record<string, Worktree[]> = {
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
      path: "/Users/rin/shigomori/worktrees/shigoto-no-mori/happy-hummingbird",
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
      path: "/Users/rin/shigomori/worktrees/shigoto-no-mori/brave-badger",
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
      path: "/Users/rin/shigomori/worktrees/shigoto-no-mori/quiet-quail",
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
      path: "/Users/rin/shigomori/worktrees/port-pool/merry-marmot",
      behind: 1,
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
        commit("77aa210", "Vendor the relay protocol notes", 6 * DAY, 5, 0),
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
    lastUsed: now - 40 * 60_000,
    recentCount: 11,
  },
  {
    id: "tp_df",
    name: "dotfiles",
    path: "/home/rin/dotfiles",
    pathExists: true,
    identity: DF_IDENTITY,
    lastUsed: now - 3 * DAY,
    recentCount: 3,
  },
];

const thinkpadWorktrees: Record<string, Worktree[]> = {
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
      path: "/home/rin/shigomori/worktrees/shigoto-no-mori/gentle-gecko",
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

// ---- Mini (offline, but the forest exists so the lab can pose "cached
// snapshot" and reconnect states by flipping it online) ----

const miniProjects: Project[] = [
  {
    id: "mini_sm",
    name: "shigoto-no-mori",
    path: "/Users/rin/dev/shigoto-no-mori",
    pathExists: true,
    identity: SM_IDENTITY,
    lastUsed: now - 3 * HOUR,
    recentCount: 4,
  },
];

const miniWorktrees: Record<string, Worktree[]> = {
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
      path: "/Users/rin/shigomori/worktrees/shigoto-no-mori/nimble-newt",
      changedCount: 7,
      ahead: 1,
      lastChangeAt: now - 3 * HOUR,
      recentCommits: [
        commit("6f0a3d1", "Note the pool retry follow-ups", 3 * HOUR, 12, 0),
      ],
    }),
  ],
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

// Peers THIS host has granted command access (the devices page toggle).
export const grantedDeviceIds = [THINKPAD_ID];

export const labGlobalConfig = {
  launchScripts: true,
  deleteBranchOnRemove: true,
  autoPopulateInstall: true,
  portPool: true,
  terrier: false,
  githubCli: true,
  directConnections: true,
};

// ---- ports ----

// port-pool's allocations by worktree id, in the project's declared
// order, and the user-added ports (what the worktree data file holds).
// Which numbers have a server behind them is a flat set: the lab poses
// liveness, it does not run servers.
export const labPoolPorts: Record<string, { name: string; port: number }[]> = {
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

export const labCustomPorts: Record<string, CustomPort[]> = {
  wt_sm_badger: [{ port: 5732, label: "api" }],
  a1b2c3d4e5f6: [{ port: 8787, label: "api" }, { port: 5555 }],
};

export const labListeningPorts = new Set([5731, 5173, 6006, 8787, 5182]);
