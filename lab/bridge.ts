// The lab's window.api: the same surface the preload exposes, served
// entirely from lab/fixtures.ts. The real renderer boots on top of it
// unmodified: startRemoteDeviceSync, HostScope, the sidebar tree and
// every remote view all derive from these answers exactly as they
// would from a live hub. Channels no fixture handler covers fall
// back to schema-derived stubs (fabricated arms allowed: this is a
// design lab, not a product surface).
//
// window.smLab carries the posing controls: flip a peer's presence,
// change the socket phase, navigate the memory router.
import { buildApi } from "@shared/ipc/client";
import type { ContractScope } from "@shared/ipc/contract";
import type { HubStatus } from "@shared/ipc/modules/hub";
import type { ClientTransport } from "@shared/ipc/transport";
import { createSubscriberRegistry } from "@shared/ipc/socket/subscriberRegistry";
import { invokeIndexFor } from "../web/bridge/loopback";
import { NO_STRUCTURAL_STUB, stubValueFor } from "../web/bridge/stubDefaults";
import {
  accountDevices,
  forests,
  grantedDeviceIds,
  labGlobalConfig,
  LAB_ACCOUNT_ID,
  LAB_APP_VERSION,
  LOCAL_DEVICE_ID,
  MINI_ID,
  projectIconFor,
  THINKPAD_ID,
  WORKPC_ID,
  type DeviceForest,
} from "./fixtures";

type FixtureHandler = (input: any) => unknown;
type FixtureHandlers = Record<string, FixtureHandler>;

type FixtureWire = {
  transport: ClientTransport;
  emit: (channel: string, payload: unknown) => void;
};

function createFixtureWire(
  scope: ContractScope,
  handlers: FixtureHandlers,
  name: string,
): FixtureWire {
  const registry = createSubscriberRegistry(`lab:${name}`);
  const index = invokeIndexFor(scope);
  return {
    transport: {
      invoke(channel, input) {
        const handler = handlers[channel];
        if (handler !== undefined) {
          return Promise.resolve().then(() => handler(input));
        }
        const def = index.get(channel);
        if (def === undefined) {
          return Promise.reject(
            new Error(`[lab] no contract entry for ${channel}`),
          );
        }
        const stub = stubValueFor(def.output, { fabricateArms: true });
        if (stub === NO_STRUCTURAL_STUB) {
          return Promise.reject(new Error(`[lab] no stub for ${channel}`));
        }
        return Promise.resolve(stub);
      },
      subscribe(channel, handler) {
        return registry.subscribe(channel, handler);
      },
    },
    emit: (channel, payload) => registry.emit(channel, payload),
  };
}

// ---- per-device host fixtures ----

function hostHandlersFor(forest: DeviceForest): FixtureHandlers {
  const collapsed = new Set<string>();
  const allWorktrees = () => Object.values(forest.worktrees).flat();
  const findWorktree = (worktreeId: string) =>
    allWorktrees().find((worktree) => worktree.id === worktreeId);
  const branchesOf = () => [
    "main",
    ...allWorktrees()
      .filter((worktree) => !worktree.isPrimary && !worktree.detached)
      .map((worktree) => worktree.branch),
  ];
  return {
    "projects:list": () => forest.projects,
    "projects:getSort": () => "manual",
    "projects:getSidebarView": () => "projects",
    "projects:getCollapsed": () => [...collapsed],
    "projects:toggleCollapsed": ({ projectId }) => {
      if (collapsed.has(projectId)) collapsed.delete(projectId);
      else collapsed.add(projectId);
      return [...collapsed];
    },
    "projects:defaultBranch": () => "main",
    "projects:listBranches": () => ({
      local: branchesOf(),
      remote: ["origin/main"],
    }),
    "projects:pickWorktreeName": () => "tender-tanuki",
    "projects:icon": ({ projectId }) =>
      projectIconFor(
        forest.projects.find((project) => project.id === projectId)?.name ?? "",
      ),
    "projects:listIgnoredPaths": () => [".env.local", "node_modules"],
    "worktrees:list": ({ projectId }) => forest.worktrees[projectId] ?? [],
    "worktrees:create": ({ projectId, worktreeName, branchName }) => {
      const name = worktreeName ?? "tender-tanuki";
      const created = {
        id: `c0ffee${String(Date.now()).slice(-6)}`,
        projectId,
        name,
        branch: branchName ?? name,
        path: `${forest.projects.find((p) => p.id === projectId)?.path ?? "/tmp"}/../worktrees/${name}`,
        ahead: 0,
        behind: 0,
        hasUpstream: false,
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
      };
      (forest.worktrees[projectId] ??= []).push(created);
      return { worktree: created };
    },
    "worktrees:listCommits": ({ worktreeId, skip }) =>
      skip > 0 ? [] : (findWorktree(worktreeId)?.recentCommits ?? []),
    "worktrees:diff": () => LAB_DIFF,
    "worktrees:commitDiff": () => LAB_DIFF,
    "remoteAccess:commandAccess": () => ({ granted: forest.grantsCaller }),
    "globalConfig:read": () => labGlobalConfig,
    "globalConfig:writeDeviceSettings": () => undefined,
    "launchers:detect": () => LAB_DETECTED,
    "launchers:forProject": () => ({
      entries: [
        ...LAB_DETECTED,
        { kind: "custom", id: "claude", label: "Claude Code" },
        { kind: "web", id: "web:github", label: "GitHub" },
      ],
      hiddenCount: 0,
    }),
    "packageScripts:list": () => ({
      scripts: {
        dev: "vite dev --port 5173",
        test: "vitest run",
        "theme:check": "node scripts/check-theme-contract.mjs",
      },
      packageManager: "pnpm",
      usage: {
        dev: { lastUsed: Date.now() - 12 * 60_000, recentCount: 9 },
        test: { lastUsed: Date.now() - 26 * 60_000, recentCount: 3 },
      },
    }),
    "packageScripts:getSort": () => "manifest",
    "githubCli:readiness": () => ({ installed: true, authed: true }),
    "githubCli:projectPullRequests": ({ projectId }) =>
      projectId === "p_sm" ? { "v2-exp/remote-ui-flows": LAB_PR_SLIM } : {},
    "githubCli:worktreePullRequest": ({ branch }) =>
      branch === "v2-exp/remote-ui-flows" ? LAB_PR_DETAIL : null,
    "githubCli:repoMergeConfig": () => ({
      merge: false,
      squash: true,
      rebase: false,
    }),
    // Local-orchestrator sync verbs, mutating the fixture world so the
    // outcome is visible: the worktree lands in the identity-matched
    // local project, and a transplant removes the source row.
    ...(forest.deviceId === LOCAL_DEVICE_ID
      ? {
          "sync:pullWorktree": (input: any) =>
            labSyncPull(forest, input, false),
          "sync:transplantWorktree": (input: any) =>
            labSyncPull(forest, input, true),
        }
      : {}),
  };
}

async function labSyncPull(
  local: DeviceForest,
  input: {
    sourceDeviceId: string;
    sourceProjectId: string;
    sourceWorktreeId: string;
    sourceIdentity: string;
    branch: string;
  },
  transplant: boolean,
) {
  await new Promise((resolve) => setTimeout(resolve, 1600));
  const project = local.projects.find(
    (entry) => entry.identity === input.sourceIdentity,
  );
  if (project === undefined) throw new Error("[lab] no identity match");
  const source = forests[input.sourceDeviceId];
  const sourceList = source?.worktrees[input.sourceProjectId] ?? [];
  const sourceWorktree = sourceList.find(
    (entry) => entry.id === input.sourceWorktreeId,
  );
  const name = sourceWorktree?.name ?? "tender-tanuki";
  const landed = {
    ...sourceWorktree,
    id: "fedcba987654",
    projectId: project.id,
    name,
    branch: input.branch,
    path: `/Users/rin/shigomori/worktrees/${project.name}/${name}`,
    ahead: sourceWorktree?.ahead ?? 0,
    behind: 0,
    hasUpstream: sourceWorktree?.hasUpstream ?? true,
    hasRemote: true,
    divergedClean: false,
    behindPrimary: 0,
    mergedIntoPrimary: false,
    changedCount: sourceWorktree?.changedCount ?? 0,
    recentCommits: sourceWorktree?.recentCommits ?? [],
    isPrimary: false,
    isExternal: false,
    detached: false,
    shelved: false,
    port: undefined,
  };
  (local.worktrees[project.id] ??= []).push(landed as any);
  if (transplant && source !== undefined) {
    source.worktrees[input.sourceProjectId] = sourceList.filter(
      (entry) => entry.id !== input.sourceWorktreeId,
    );
  }
  return {
    worktree: landed,
    captured: (sourceWorktree?.changedCount ?? 0) > 0,
    dirtyApplied: (sourceWorktree?.changedCount ?? 0) > 0,
    ...(transplant ? { sourceRemoved: true } : {}),
  };
}

const LAB_DETECTED = [
  { kind: "detected", id: "vscode", label: "VS Code", available: true },
  { kind: "detected", id: "terminal", label: "Terminal", available: true },
  { kind: "detected", id: "finder", label: "Finder", available: true },
] as const;

const LAB_PR_SLIM = {
  number: 148,
  url: "https://github.com/sylophi/shigoto-no-mori/pull/148",
  title: "Aggregate worktrees across devices",
  state: "OPEN" as const,
  isDraft: false,
};

const LAB_PR_DETAIL = {
  ...LAB_PR_SLIM,
  mergeState: "CLEAN" as const,
  baseRefName: "main",
  authorLogin: "sylophi",
  updatedAt: new Date(Date.now() - 40 * 60_000).toISOString(),
  additions: 412,
  deletions: 96,
  changedFiles: 14,
  checks: {
    total: 2,
    passed: 2,
    failing: 0,
    pending: 0,
    neutral: 0,
    skipped: 0,
  },
  checkList: [
    { name: "battery", bucket: "passed" as const },
    { name: "theme:check", bucket: "passed" as const },
  ],
};

const LAB_DIFF = `diff --git a/renderer/components/sidebar/RowContent.tsx b/renderer/components/sidebar/RowContent.tsx
index 4f2c9d1..a91f3c7 100644
--- a/renderer/components/sidebar/RowContent.tsx
+++ b/renderer/components/sidebar/RowContent.tsx
@@ -12,6 +12,8 @@ import { WorktreeRowLabel } from "./WorktreeRow";
+import { DeviceBadge } from "./DeviceBadge";
+
 export function RowContent({ row }: { row: SidebarRow }) {
`;

// ---- lab-mutable account/presence state ----

const granted = new Set(grantedDeviceIds);
// Devices revoked in this lab session: the fixture registry is static,
// so the revoke handler records the id here and the list filters it.
const revoked = new Set<string>();
let deviceName = "Studio Mac";

// The web-shell pose (lab/web-main.tsx): this page is an enrolled
// BROWSER device, every machine forest (Studio Mac included) is a
// peer, and nothing is local. Passed into installLabBridge rather than
// read from a global, since import hoisting evaluates this module
// before any entry-file code runs.
let WEB_SHELL = false;
const WEB_DEVICE_ID = "dev_beefcafe01";

// Presence the lab can pose: which peers are in the roster, and which
// of those have an established direct session. ?peers=tp:connected,
// mini:online,pc:offline overrides the default (Thinkpad connected,
// the rest offline, and the web shell also defaults Studio Mac
// connected).
const PEER_KEYS: Record<string, string> = {
  sm: LOCAL_DEVICE_ID,
  tp: THINKPAD_ID,
  mini: MINI_ID,
  pc: WORKPC_ID,
};
const roster = new Set<string>();
const directSessions = new Set<string>();

function initPresence(): void {
  const posed = new URLSearchParams(location.search).get("peers");
  const entries = (
    posed ?? (WEB_SHELL ? "sm:connected,tp:connected" : "tp:connected")
  ).split(",");
  for (const entry of entries) {
    const [key, state] = entry.split(":");
    const id = PEER_KEYS[key?.trim() ?? ""];
    if (id === undefined) continue;
    if (state === "connected" || state === "online") roster.add(id);
    if (state === "connected") directSessions.add(id);
  }
}
let socketPhase: HubStatus["socket"] = {
  phase: "connected",
  remoteDeviceId: "",
  remoteAppVersion: "",
};

function hubSnapshot(): HubStatus {
  const peerAppVersions: Record<string, string> = {};
  for (const id of directSessions) peerAppVersions[id] = LAB_APP_VERSION;
  return {
    socket: socketPhase,
    onlineDeviceIds: [...roster],
    peerAppVersions,
    tunnel: "up",
  };
}

export function installLabBridge(opts: { webShell?: boolean } = {}) {
  WEB_SHELL = opts.webShell === true;
  initPresence();
  // Remote hosts: one fixture wire per device, reached only through
  // hub:invokePeer exactly like the real hub bridge. Under the web
  // shell every machine forest (Studio Mac included) is a peer of the
  // browser device, while on desktop Studio Mac is the local host.
  const selfDeviceId = WEB_SHELL ? WEB_DEVICE_ID : LOCAL_DEVICE_ID;
  const peerWires = new Map<string, FixtureWire>();
  for (const forest of Object.values(forests)) {
    if (forest.deviceId === selfDeviceId) continue;
    peerWires.set(
      forest.deviceId,
      createFixtureWire("host", hostHandlersFor(forest), forest.deviceId),
    );
  }

  // The web shell has no local forest: its host wire serves nothing, so
  // every host read falls back to the schema stubs (empty lists),
  // matching the real browser bridge's shape.
  const localHost = createFixtureWire(
    "host",
    WEB_SHELL ? {} : hostHandlersFor(forests[LOCAL_DEVICE_ID]),
    "local",
  );

  const registryDevices = () =>
    (WEB_SHELL
      ? [
          ...accountDevices,
          {
            deviceId: WEB_DEVICE_ID,
            name: "Chrome on MacBook",
            platform: "web",
            createdAt: Date.now() - 2 * 24 * 3_600_000,
            lastSeenAt: Date.now(),
            online: true,
          },
        ]
      : accountDevices
    ).filter((device) => !revoked.has(device.deviceId));

  const accountStatus = () => ({
    configured: true,
    signedIn: true,
    accountId: LAB_ACCOUNT_ID,
    deviceName: WEB_SHELL ? "Chrome on MacBook" : deviceName,
  });

  const clientHandlers: FixtureHandlers = {
    "account:status": accountStatus,
    "account:listDevices": () => registryDevices(),
    "account:listGrantedDevices": () => [...granted],
    "account:grantCommands": (deviceId: string) => {
      granted.add(deviceId);
      client.emit("account:grantsChanged", undefined);
    },
    "account:revokeCommands": (deviceId: string) => {
      granted.delete(deviceId);
      client.emit("account:grantsChanged", undefined);
    },
    "account:revokeDevice": (deviceId: string) => {
      // Mirrors the real handler's registry effect: the device leaves
      // the account list and account:changed fans out the refetch.
      // Fixture presence is untouched, matching the hub's lag.
      revoked.add(deviceId);
      client.emit("account:changed", undefined);
    },
    "account:setDeviceName": (name: string) => {
      deviceName = name;
      client.emit("account:changed", undefined);
      return accountStatus();
    },
    "account:enroll": () => accountStatus(),
    "account:signOut": () => undefined,
    "clientConfig:read": () => {
      try {
        return JSON.parse(localStorage.getItem("sm.lab.clientConfig") ?? "{}");
      } catch {
        return {};
      }
    },
    "clientConfig:write": ({ config }) => {
      localStorage.setItem("sm.lab.clientConfig", JSON.stringify(config));
    },
    "hub:status": hubSnapshot,
    "hub:invokePeer": ({ deviceId, channel, input }) => {
      const wire = peerWires.get(deviceId);
      if (wire === undefined) {
        return Promise.reject(new Error(`[lab] unknown peer ${deviceId}`));
      }
      return wire.transport.invoke(channel, input);
    },
    "shell:openExternal": ({ url }) => {
      window.open(url, "_blank", "noopener,noreferrer");
    },
    "shell:showItemInFolder": () => undefined,
    "portForward:list": () => ({
      forwards: [
        {
          forwardId: "a3f19c2e77b04d5586e1f20c9ab34d61",
          deviceId: THINKPAD_ID,
          remotePort: 5173,
          localPort: 5173,
          connCount: 2,
        },
      ],
    }),
    "portForward:start": ({ remotePort, localPort }) => ({
      forwardId: "b4e20d3f88c15e6697f2031dabc45e72",
      localPort: localPort ?? remotePort,
    }),
    "portForward:stop": () => undefined,
  };

  const client = createFixtureWire("client", clientHandlers, "client");

  const api = {
    deviceId: selfDeviceId,
    appVersion: LAB_APP_VERSION,
    clerkPublishableKey: "pk_test_lab",
    isDev: true,
    isElectron: !WEB_SHELL,
    ...buildApi({ host: localHost.transport, client: client.transport }),
  };
  // The renderer's window.d.ts types window.api off the preload, and
  // the lab bridge satisfies the same runtime surface.
  (window as any).api = api;

  const pushHub = () => client.emit("hub:statusChanged", hubSnapshot());

  (window as any).smLab = {
    // "connected" | "online" | "offline"
    setPeer(deviceId: string, state: "connected" | "online" | "offline") {
      roster.delete(deviceId);
      directSessions.delete(deviceId);
      if (state !== "offline") roster.add(deviceId);
      if (state === "connected") directSessions.add(deviceId);
      pushHub();
    },
    setSocket(phase: HubStatus["socket"]) {
      socketPhase = phase;
      pushHub();
    },
    emitClient: client.emit,
    emitHost: localHost.emit,
  };
}
