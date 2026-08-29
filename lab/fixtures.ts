// The lab's fixture world: one account, four devices, forests shaped
// after the owner's v2 flow mockups (Studio Mac local; Thinkpad online
// with a direct session; Mini and Work PC offline). Pure data — the
// bridge (lab/bridge.ts) serves it over fixture transports.
import type { DeviceInfo } from "@shared/relay/protocol";
import type { Project, Worktree, CommitSummary } from "@shared/schemas";

export const LAB_ACCOUNT_ID = "user_2rin8xk3";
export const LAB_APP_VERSION = "2.0.3";

export const LOCAL_DEVICE_ID = "dev_8f3ac2e1";
export const THINKPAD_ID = "dev_1c94b0da";
export const MINI_ID = "dev_5b0e77aa";
export const WORKPC_ID = "dev_a02f61c3";

const now = Date.now();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

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

// Every field WorktreeSchema requires, with quiet defaults; overrides
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
      port: 5731,
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
      id: "tp_sm_main",
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
      id: "tp_sm_gecko",
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
      id: "tp_df_main",
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

// ---- Mini (offline; the forest exists so the lab can pose "cached
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
      id: "mini_sm_main",
      projectId: "mini_sm",
      name: "shigoto-no-mori",
      branch: "main",
      path: "/Users/rin/dev/shigoto-no-mori",
      isPrimary: true,
      recentCommits: [],
    }),
    worktree({
      id: "mini_sm_newt",
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
