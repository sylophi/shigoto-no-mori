// The lab's window.api: the same surface the preload exposes, served
// entirely from lab/fixtures.ts. The real renderer boots on top of it
// unmodified — startRemoteDeviceSync, HostScope, the sidebar tree and
// every remote view all derive from these answers exactly as they
// would from a live relay. Channels no fixture handler covers fall
// back to schema-derived stubs (fabricated arms allowed: this is a
// design lab, not a product surface).
//
// window.smLab carries the posing controls: flip a peer's presence,
// change the socket phase, navigate the memory router.
import { allContractModules, buildApi } from "@shared/ipc/client";
import type { ContractScope, InvokeDef } from "@shared/ipc/contract";
import type { RelayStatus } from "@shared/ipc/modules/relay";
import type { ClientTransport } from "@shared/ipc/transport";
import { createSubscriberRegistry } from "@shared/ipc/socket/subscriberRegistry";
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
  THINKPAD_ID,
  WORKPC_ID,
  type DeviceForest,
} from "./fixtures";

type FixtureHandler = (input: any) => unknown;
type FixtureHandlers = Record<string, FixtureHandler>;

function invokeIndexFor(scope: ContractScope): Map<string, InvokeDef> {
  const index = new Map<string, InvokeDef>();
  for (const module of allContractModules) {
    if (module.scope !== scope) continue;
    for (const def of Object.values(module.calls)) {
      if (def.kind === "invoke") index.set(def.channel, def);
    }
  }
  return index;
}

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
    "projects:icon": () => null,
    "projects:listIgnoredPaths": () => [".env.local", "node_modules"],
    "worktrees:list": ({ projectId }) => forest.worktrees[projectId] ?? [],
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
    "githubCli:worktreePullRequest": ({ worktreeId }) =>
      worktreeId === "wt_sm_hum" ? LAB_PR_DETAIL : null,
    "githubCli:repoMergeConfig": () => ({
      merge: false,
      squash: true,
      rebase: false,
    }),
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
let deviceName = "Studio Mac";

// Presence the lab can pose: which peers are in the roster, and which
// of those have an established direct session. ?peers=tp:connected,
// mini:online,pc:offline overrides the default (Thinkpad connected,
// the rest offline).
const PEER_KEYS: Record<string, string> = {
  tp: THINKPAD_ID,
  mini: MINI_ID,
  pc: WORKPC_ID,
};
const roster = new Set<string>();
const directSessions = new Set<string>();
{
  const posed = new URLSearchParams(location.search).get("peers");
  const entries = (posed ?? "tp:connected").split(",");
  for (const entry of entries) {
    const [key, state] = entry.split(":");
    const id = PEER_KEYS[key?.trim() ?? ""];
    if (id === undefined) continue;
    if (state === "connected" || state === "online") roster.add(id);
    if (state === "connected") directSessions.add(id);
  }
}
let socketPhase: RelayStatus["socket"] = {
  phase: "connected",
  remoteDeviceId: "",
  remoteAppVersion: "",
};

function relaySnapshot(): RelayStatus {
  const peerAppVersions: Record<string, string> = {};
  for (const id of directSessions) peerAppVersions[id] = LAB_APP_VERSION;
  return {
    socket: socketPhase,
    onlineDeviceIds: [...roster],
    peerAppVersions,
    tunnel: "up",
  };
}

export function installLabBridge() {
  // Remote hosts: one fixture wire per device, reached only through
  // relay:invokePeer exactly like the real relay bridge.
  const peerWires = new Map<string, FixtureWire>();
  for (const forest of Object.values(forests)) {
    if (forest.deviceId === LOCAL_DEVICE_ID) continue;
    peerWires.set(
      forest.deviceId,
      createFixtureWire("host", hostHandlersFor(forest), forest.deviceId),
    );
  }

  const localHost = createFixtureWire(
    "host",
    hostHandlersFor(forests[LOCAL_DEVICE_ID]),
    "local",
  );

  const accountStatus = () => ({
    configured: true,
    signedIn: true,
    accountId: LAB_ACCOUNT_ID,
    deviceName,
  });

  const clientHandlers: FixtureHandlers = {
    "account:status": accountStatus,
    "account:listDevices": () => accountDevices,
    "account:listGrantedDevices": () => [...granted],
    "account:grantCommands": (deviceId: string) => {
      granted.add(deviceId);
      client.emit("account:grantsChanged", undefined);
    },
    "account:revokeCommands": (deviceId: string) => {
      granted.delete(deviceId);
      client.emit("account:grantsChanged", undefined);
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
    "relay:status": relaySnapshot,
    "relay:invokePeer": ({ deviceId, channel, input }) => {
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
    deviceId: LOCAL_DEVICE_ID,
    appVersion: LAB_APP_VERSION,
    clerkPublishableKey: "pk_test_lab",
    isDev: true,
    isElectron: true,
    ...buildApi({ host: localHost.transport, client: client.transport }),
  };
  // The renderer's window.d.ts types window.api off the preload; the
  // lab bridge satisfies the same runtime surface.
  (window as any).api = api;

  const pushRelay = () => client.emit("relay:statusChanged", relaySnapshot());

  (window as any).smLab = {
    // "connected" | "online" | "offline"
    setPeer(deviceId: string, state: "connected" | "online" | "offline") {
      roster.delete(deviceId);
      directSessions.delete(deviceId);
      if (state !== "offline") roster.add(deviceId);
      if (state === "connected") directSessions.add(deviceId);
      pushRelay();
    },
    setSocket(phase: RelayStatus["socket"]) {
      socketPhase = phase;
      pushRelay();
    },
    emitClient: client.emit,
    emitHost: localHost.emit,
  };
}
