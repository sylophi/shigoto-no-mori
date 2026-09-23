// The lab's window.api: the same surface the preload exposes, served
// entirely from lab/fixtures.ts. The real renderer boots on top of it
// unmodified: startRemoteDeviceSync, HostScope, the sidebar tree and
// every remote view all derive from these answers exactly as they
// would from a live device hub. Channels no fixture handler covers fall
// back to schema-derived stubs (fabricated arms allowed: this is a
// design lab, not a product surface).
//
// window.smLab carries the posing controls: flip a peer's presence,
// change the socket phase, navigate the memory router.
import { buildApi } from "@shared/ipc/client";
import { mergeWorktreePorts } from "@shared/ports/mergeWorktreePorts";
import type {
  Project,
  SharedSettingsDoc,
  ShigomoriWorktreeData,
} from "@shared/schemas";
import { repoNameFromUrl } from "@shared/cloneUrl";
import { normalizeRemoteUrl } from "@shared/git/repoIdentity.mts";
import {
  createSharedSettingsCopy,
  EMPTY_SHARED_SETTINGS,
} from "@shared/sharedSettings";
import type { ContractScope } from "@shared/ipc/contract";
import { WEB_PLATFORM } from "@shared/account/enroll";
import type { HubStatus } from "@shared/ipc/modules/hub";
import {
  MIRROR_HISTORY_LIMIT,
  summarizeIgnores,
} from "@shared/ipc/modules/mirror";
import { pullBringsIgnoredFiles } from "@shared/ipc/modules/sync";
import type {
  MirrorEvent,
  MirrorServing,
  MirrorSession,
} from "@shared/ipc/modules/mirror";
import type { ClientTransport } from "@shared/ipc/transport";
import { createSubscriberRegistry } from "@shared/ipc/socket/subscriberRegistry";
import { invokeIndexFor } from "../web/ipc/loopback";
import { NO_STRUCTURAL_STUB, stubValueFor } from "../web/ipc/stubDefaults";
import {
  type DeviceForest,
  type LabDisk,
  LAB_ACCOUNT_ID,
  LAB_APP_VERSION,
  LOCAL_DEVICE_ID,
  MINI_ID,
  THINKPAD_ID,
  WORKPC_ID,
  accountDevices,
  forests,
  labCustomPorts,
  labDisks,
  labGlobalConfig,
  labListeningPorts,
  labPoolPorts,
  labRemoteUrls,
  projectIconFor,
  worktree as worktreeFixture,
} from "./fixtures";

type FixtureHandler = (input: any) => unknown;
type FixtureHandlers = Record<string, FixtureHandler>;

type FixtureWire = {
  transport: ClientTransport;
  emit: (channel: string, payload: unknown) => void;
};

// Handlers are built from the wire's own emitter, so a fixture that
// streams (the pull's progress frames) broadcasts on the wire it
// answers on.
function createFixtureWire(
  scope: ContractScope,
  handlersFor: (emit: FixtureWire["emit"]) => FixtureHandlers,
  name: string,
): FixtureWire {
  const registry = createSubscriberRegistry(`lab:${name}`);
  const index = invokeIndexFor(scope);
  const emit: FixtureWire["emit"] = (channel, payload) =>
    registry.emit(channel, payload);
  const handlers = handlersFor(emit);
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
    emit,
  };
}

// ---- per-device host fixtures ----

// One device's copy of the shared settings, in memory, over the real
// copy rule, so a pick made in the lab stamps, announces and converges
// the way it does between machines.
function sharedSettingsHandlersFor(
  deviceId: string,
  emit: FixtureWire["emit"],
): FixtureHandlers {
  let doc: SharedSettingsDoc = EMPTY_SHARED_SETTINGS;
  const copy = createSharedSettingsCopy(
    {
      read: () => doc,
      transact: (next) => {
        doc = next(doc) ?? doc;
      },
    },
    {
      deviceId: () => deviceId,
      announce: (moved) => emit("sharedSettings:changed", moved),
    },
  );
  return {
    "sharedSettings:read": () => copy.read(),
    "sharedSettings:set": ({ key, value }) => copy.set(key, value),
    "sharedSettings:merge": ({ doc: incoming }) => copy.merge(incoming),
  };
}

// A typed path as the device's disk spells it: `~` expanded against
// that device's home, trailing separators dropped.
function resolveOnDisk(disk: LabDisk, path: string): string {
  const expanded =
    path === "~" || path.startsWith("~/") ? disk.home + path.slice(1) : path;
  return expanded.length > 1 ? expanded.replace(/\/+$/, "") : expanded;
}

function isRepoOnDisk(disk: LabDisk, path: string): boolean {
  const cut = path.lastIndexOf("/");
  return (disk.dirs[path.slice(0, cut) || "/"] ?? []).some(
    (entry) => entry.name === path.slice(cut + 1) && entry.isGitRepo,
  );
}

// What registering a checkout does to the fixture world: the project
// joins the device's list with a primary worktree on main, so the add
// flow has somewhere to land and the sidebar shows it.
function registerProject(
  disk: LabDisk,
  forest: DeviceForest,
  path: string,
  identity: string | null = null,
): Project {
  if (!isRepoOnDisk(disk, path)) {
    throw new Error(`${path} is not a git repository`);
  }
  if (forest.projects.some((project) => project.path === path)) {
    throw new Error(`${path} is already registered`);
  }
  const name = path.slice(path.lastIndexOf("/") + 1);
  const project: Project = {
    id: `lab_${forest.projects.length}_${name}`,
    name,
    path,
    pathExists: true,
    identity,
    lastUsed: Date.now(),
    recentCount: 0,
  };
  forest.projects.push(project);
  forest.worktrees[project.id] = [
    worktreeFixture({
      id: `lab${String(Date.now()).slice(-9)}`,
      projectId: project.id,
      name,
      branch: "main",
      path,
      isPrimary: true,
    }),
  ];
  return project;
}

function hostHandlersFor(
  forest: DeviceForest,
  emit: FixtureWire["emit"],
): FixtureHandlers {
  const collapsed = new Set<string>();
  const disk = labDisks[forest.deviceId] ?? { home: "/home/rin", dirs: {} };
  mirrorWires.set(forest.deviceId, emit);
  // The worktree data files, seeded from the fixtures and mutated by
  // worktreeData:write so adding and removing ports shows its outcome.
  const worktreeData = new Map<string, ShigomoriWorktreeData>(
    Object.entries(labCustomPorts).map(([id, ports]) => [id, { ports }]),
  );
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
    ...sharedSettingsHandlersFor(forest.deviceId, emit),
    // A copy, as a wire would hand over: projects:add and projects:clone
    // push onto the list, and the same array back would read as "nothing
    // changed" to the query cache's structural sharing.
    "projects:list": () => [...forest.projects],
    "projects:add": ({ path }) =>
      registerProject(disk, forest, resolveOnDisk(disk, path)),
    // Takes a moment, as a clone does, so the cloning stage is seen.
    "projects:clone": async ({ url, parentDir, name }) => {
      await new Promise((resolve) => setTimeout(resolve, 2200));
      const parent = resolveOnDisk(disk, parentDir);
      const entries = disk.dirs[parent];
      if (entries === undefined) throw new Error(`${parent} is not a folder`);
      const folder = name ?? repoNameFromUrl(url) ?? "repo";
      if (entries.some((entry) => entry.name === folder)) {
        throw new Error(`${parent}/${folder} already exists`);
      }
      entries.push({ name: folder, isGitRepo: true });
      const identity =
        Object.entries(labRemoteUrls).find(
          ([, known]) => normalizeRemoteUrl(known) === normalizeRemoteUrl(url),
        )?.[0] ?? `remote:${normalizeRemoteUrl(url)}`;
      return registerProject(disk, forest, `${parent}/${folder}`, identity);
    },
    "projects:cloneUrl": ({ projectId }) => {
      const identity = forest.projects.find(
        (project) => project.id === projectId,
      )?.identity;
      return identity ? (labRemoteUrls[identity] ?? null) : null;
    },
    "runtime:info": () => ({
      dataDir: `${disk.home}/.sm`,
      dataDirSource: "default",
      atDefaultDataDir: true,
      canonicalDataDirName: ".sm",
      homedir: disk.home,
    }),
    "fs:listDirectory": ({ path }) => {
      const resolved = resolveOnDisk(disk, path);
      const entries = disk.dirs[resolved];
      if (entries === undefined) {
        throw new Error(
          `ENOENT: no such file or directory, scandir '${resolved}'`,
        );
      }
      return { path: resolved, entries };
    },
    "fs:isGitRepo": ({ path }) => isRepoOnDisk(disk, resolveOnDisk(disk, path)),
    "fs:scanForGitRepos": async ({ path }) => {
      await new Promise((resolve) => setTimeout(resolve, 900));
      const root = resolveOnDisk(disk, path);
      return Object.entries(disk.dirs).flatMap(([folder, entries]) =>
        folder === root || folder.startsWith(`${root}/`)
          ? entries
              .filter((entry) => entry.isGitRepo)
              .map((entry) => `${folder}/${entry.name}`)
          : [],
      );
    },
    "projects:getSort": () => "manual",
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
    "worktrees:list": ({ projectId }) => [
      ...(forest.worktrees[projectId] ?? []),
    ],
    "worktrees:create": ({ projectId, worktreeName, branchName }) => {
      const name = worktreeName ?? "tender-tanuki";
      const created = worktreeFixture({
        id: `c0ffee${String(Date.now()).slice(-6)}`,
        projectId,
        name,
        branch: branchName ?? name,
        path: `${forest.projects.find((p) => p.id === projectId)?.path ?? "/tmp"}/../worktrees/${name}`,
        hasUpstream: false,
      });
      (forest.worktrees[projectId] ??= []).push(created);
      return { worktree: created };
    },
    "worktrees:listCommits": ({ worktreeId, skip }) =>
      skip > 0 ? [] : (findWorktree(worktreeId)?.recentCommits ?? []),
    "worktrees:fileDiff": () => LAB_DIFF,
    "worktrees:changeStatus": () => [],
    "worktrees:commitDiff": () => LAB_DIFF,
    "worktreeData:read": ({ worktreeId }) =>
      worktreeData.get(worktreeId) ?? null,
    "worktreeData:write": ({ worktreeId, data }) => {
      worktreeData.set(worktreeId, data);
    },
    // The host's own merge, with the posed liveness mapped on.
    "ports:list": ({ worktreeId }) => ({
      ports: mergeWorktreePorts(
        labPoolPorts[worktreeId] ?? [],
        worktreeData.get(worktreeId)?.ports ?? [],
      ).map((entry) =>
        Object.assign(entry, { listening: labListeningPorts.has(entry.port) }),
      ),
    }),
    "remoteAccess:commandAccess": () => ({ granted: forest.grantsCaller }),
    // The stub's shape with a full create lifecycle on it (carry-over,
    // a setup script, and ports below), so the pull dialogs' setup
    // switch and their running steps have every phase to name.
    "shigomori:read": () => ({
      defaultBranch: "main",
      scripts: { setup: "pnpm install" },
      carryOver: [
        { path: ".env.local", mode: "copy" },
        { path: ".claude/settings.local.json", mode: "symlink" },
      ],
      launchers: [],
    }),
    "portPool:isActive": () => true,
    "globalConfig:read": () => labGlobalConfig,
    "globalConfig:writeDeviceSettings": () => undefined,
    // Thinkpad has an update staged, so its Settings section's
    // restart-to-update button has something to show. Everyone else is
    // up to date.
    "updater:get": () =>
      forest.deviceId === THINKPAD_ID
        ? { kind: "ready", version: "2.1.0", releaseDate: null }
        : { kind: "idle" },
    "updater:check": () => undefined,
    "updater:install": () => undefined,
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
    "sync:worktreeFolder": ({ relative }: { relative: string }) => [
      ...(LAB_TREE[relative] ?? []),
    ],
    "sync:ignoredPaths": () => ({
      paths: [...LAB_IGNORED_PATHS],
      total: LAB_IGNORED_PATHS.length,
      patterns: [...LAB_IGNORED_PATHS],
    }),
    // The mirror picture is host-scoped: the local forest reports the
    // sessions it runs, and a source forest reports the streams it
    // serves. Both refresh off mirror:changed. Copies, since the posed
    // cycle mutates the session in place.
    "mirror:list": () => ({
      daemon: labMirrors.sessions.length > 0 ? "running" : "stopped",
      sessions:
        forest.deviceId === LOCAL_DEVICE_ID
          ? labMirrors.sessions.map((session) => ({ ...session }))
          : [],
      serving: labMirrors.serving
        .filter((stream) => stream.deviceId === forest.deviceId)
        .map(({ deviceId: _device, ...stream }) => stream),
    }),
    "mirror:history": ({ localWorktreeId }: { localWorktreeId: string }) => ({
      events: [...(labMirrors.history[localWorktreeId] ?? [])],
    }),
    // Local-orchestrator sync verbs, mutating the fixture world so the
    // outcome is visible: the worktree lands in the identity-matched
    // local project, and a teardown removes the source row.
    ...(forest.deviceId === LOCAL_DEVICE_ID
      ? {
          "sync:pullWorktree": (input: any) => labSyncPull(forest, emit, input),
          "mirror:start": (input: any) => labMirrorStart(forest, emit, input),
          "mirror:stop": ({ session }: { session: string }) => {
            const entry = findLabSession(session);
            labMirrors.sessions = labMirrors.sessions.filter(
              (s) => s.session !== session,
            );
            labMirrors.serving = labMirrors.serving.filter(
              (stream) =>
                !(
                  entry !== undefined &&
                  stream.deviceId === entry.deviceId &&
                  stream.worktreeId === entry.worktreeId
                ),
            );
            if (entry) {
              // The stop takes the local copy with it, as the host's
              // forced delete does (and the copy's history thread
              // goes with the worktree, so nothing is noted).
              forest.worktrees[entry.localProjectId] = (
                forest.worktrees[entry.localProjectId] ?? []
              ).filter((w) => w.id !== entry.localWorktreeId);
              emit("git:externalChange", undefined);
            }
            mirrorChanged();
          },
          "mirror:pause": ({ session }: { session: string }) =>
            setMirrorPaused(session, true),
          "mirror:resume": ({ session }: { session: string }) =>
            setMirrorPaused(session, false),
          "mirror:setIgnores": ({
            session,
            ignoreMode,
            ignores,
          }: {
            session: string;
            ignoreMode: MirrorSession["ignoreMode"];
            ignores: string[];
          }) => {
            const entry = findLabSession(session);
            if (entry === undefined) throw new Error("[lab] no such mirror");
            entry.session = `sync_${labSessionSerial++}`;
            entry.ignoreMode = ignoreMode;
            entry.ignores = ignores;
            entry.createdAt = Date.now();
            entry.successfulCycles = 0;
            noteMirrorEvent(
              entry.localWorktreeId,
              "ignores-changed",
              summarizeIgnores(ignoreMode, ignores),
            );
            mirrorChanged();
            return { session: entry.session };
          },
          "sync:teardownSource": (input: any) => {
            const source = forests[input.sourceDeviceId];
            if (source !== undefined) {
              source.worktrees[input.sourceProjectId] = (
                source.worktrees[input.sourceProjectId] ?? []
              ).filter((entry) => entry.id !== input.sourceWorktreeId);
            }
            return { sourceRemoved: true };
          },
        }
      : {}),
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// What git ignores on the posed worktree (LAB_TREE's ignored entries,
// folders collapsed), serving as its gitignore rules too.
const LAB_IGNORED_PATHS = [
  ".cache/",
  ".env",
  ".env.local",
  ".eslintcache",
  ".turbo/",
  ".vite/",
  "coverage/",
  "dist/",
  "dist-cli/",
  "node_modules/",
  "out/",
  "playwright-report/",
  "src/generated/",
  "test-results/",
  "tmp/",
  "tsconfig.tsbuildinfo",
];

// The folder tree the mirror picker browses, one posed worktree.
const LAB_TREE: Record<
  string,
  { name: string; isDirectory: boolean; ignored: boolean }[]
> = {
  "": [
    { name: ".cache", isDirectory: true, ignored: true },
    { name: ".turbo", isDirectory: true, ignored: true },
    { name: ".vite", isDirectory: true, ignored: true },
    { name: "coverage", isDirectory: true, ignored: true },
    { name: "dist", isDirectory: true, ignored: true },
    { name: "dist-cli", isDirectory: true, ignored: true },
    { name: "node_modules", isDirectory: true, ignored: true },
    { name: "out", isDirectory: true, ignored: true },
    { name: "playwright-report", isDirectory: true, ignored: true },
    { name: "src", isDirectory: true, ignored: false },
    { name: "test-results", isDirectory: true, ignored: true },
    { name: "tmp", isDirectory: true, ignored: true },
    { name: ".env", isDirectory: false, ignored: true },
    { name: ".env.local", isDirectory: false, ignored: true },
    { name: ".eslintcache", isDirectory: false, ignored: true },
    { name: ".gitignore", isDirectory: false, ignored: false },
    { name: "package.json", isDirectory: false, ignored: false },
    { name: "README.md", isDirectory: false, ignored: false },
    { name: "tsconfig.tsbuildinfo", isDirectory: false, ignored: true },
  ],
  src: [
    { name: "components", isDirectory: true, ignored: false },
    { name: "generated", isDirectory: true, ignored: true },
    { name: "index.ts", isDirectory: false, ignored: false },
  ],
  "src/generated": [{ name: "schema.ts", isDirectory: false, ignored: true }],
  dist: [{ name: "bundle.js", isDirectory: false, ignored: true }],
};

// ---- mirror fixtures ----
//
// One lab-wide mirror world, since a session on Studio Mac and the
// stream Thinkpad serves for it are two views of the same fact. Each
// forest's wire is remembered so mirror:changed reaches the local page
// through its own wire and a peer's page through the client wire's
// peer push, exactly as the real bridge delivers it.
const labMirrors: {
  sessions: MirrorSession[];
  serving: (MirrorServing & { deviceId: string })[];
  history: Record<string, MirrorEvent[]>;
} = { sessions: [], serving: [], history: {} };
const mirrorWires = new Map<string, FixtureWire["emit"]>();
let pushFromPeer: (deviceId: string, channel: string) => void = () => {};
let labSessionSerial = 1;

function mirrorChanged() {
  for (const [deviceId, emit] of mirrorWires) {
    if (deviceId === LOCAL_DEVICE_ID) emit("mirror:changed", undefined);
    else pushFromPeer(deviceId, "mirror:changed");
  }
}

function noteMirrorEvent(
  localWorktreeId: string,
  kind: MirrorEvent["kind"],
  detail: string,
) {
  const thread = labMirrors.history[localWorktreeId] ?? [];
  thread.unshift({ at: Date.now(), kind, detail });
  labMirrors.history[localWorktreeId] = thread.slice(0, MIRROR_HISTORY_LIMIT);
}

function findLabSession(session: string): MirrorSession | undefined {
  return labMirrors.sessions.find((s) => s.session === session);
}

function setMirrorPaused(session: string, paused: boolean) {
  const entry = findLabSession(session);
  if (entry === undefined) return;
  entry.paused = paused;
  entry.status = paused ? "disconnected" : "watching";
  entry.statusText = paused ? "Paused" : "Watching for changes";
  noteMirrorEvent(entry.localWorktreeId, paused ? "paused" : "resumed", "");
  mirrorChanged();
}

const endpointState = () => ({
  connected: true,
  scanned: true,
  directories: 42,
  files: 318,
  symbolicLinks: 0,
  totalFileSize: 4_820_000,
  problems: [],
  excludedProblems: 0,
});

// A posed mirror: the pull lands the worktree, then a session opens
// on top and settles. Afterwards a cycle runs every few seconds so the
// status is seen moving, and the thread gets a conflict once, for the
// history to have more than its start.
async function labMirrorStart(
  local: DeviceForest,
  emit: FixtureWire["emit"],
  input: Parameters<typeof labSyncPull>[2] & {
    ignoreMode: MirrorSession["ignoreMode"];
    ignores: string[];
  },
) {
  // The rule is the session's, not the pull's: a mirror start brings
  // the files through its own session, so the pull poses no files step.
  const landed = await labSyncPull(local, emit, {
    ...input,
    ignoreMode: undefined,
  });
  const source = forests[input.sourceDeviceId];
  const sourceWorktree = (source?.worktrees[input.sourceProjectId] ?? []).find(
    (entry) => entry.id === input.sourceWorktreeId,
  );
  const tip = sourceWorktree?.recentCommits[0]?.hash.slice(0, 7) ?? "58c21fe";
  const session: MirrorSession = {
    session: `sync_${labSessionSerial++}`,
    name: `sm-${landed.worktree.id}`,
    labels: {},
    localRoot: landed.worktree.path,
    localProjectId: landed.worktree.projectId,
    localWorktreeId: landed.worktree.id,
    deviceId: input.sourceDeviceId,
    projectId: input.sourceProjectId,
    worktreeId: input.sourceWorktreeId,
    remoteRoot: sourceWorktree?.path ?? "",
    paused: false,
    ignores: input.ignores,
    ignoreMode: input.ignoreMode,
    createdAt: Date.now(),
    status: "connecting-remote",
    statusText: "Connecting to beta",
    successfulCycles: 0,
    conflicts: [],
    excludedConflicts: 0,
    local: endpointState(),
    remote: endpointState(),
    git: { status: "synced", detail: `both sides at ${tip}` },
  };
  labMirrors.sessions.push(session);
  labMirrors.serving.push({
    deviceId: input.sourceDeviceId,
    channelId: "a1b2c3d4e5f60718293a4b5c6d7e8f90",
    projectId: input.sourceProjectId,
    worktreeId: input.sourceWorktreeId,
    peerDeviceId: LOCAL_DEVICE_ID,
    peerWorktreeId: landed.worktree.id,
    since: Date.now(),
  });
  noteMirrorEvent(
    landed.worktree.id,
    "started",
    summarizeIgnores(input.ignoreMode, input.ignores),
  );
  mirrorChanged();
  void (async () => {
    const live = () => labMirrors.sessions.includes(session);
    const step = async (status: MirrorSession["status"], ms: number) => {
      if (!live() || session.paused) return;
      session.status = status;
      mirrorChanged();
      await sleep(ms);
    };
    await step("scanning", 900);
    await step("watching", 0);
    session.successfulCycles = 1;
    noteMirrorEvent(landed.worktree.id, "connected", "");
    mirrorChanged();
    // oxlint-disable no-await-in-loop -- a posed mirror cycles in sequence
    for (;;) {
      await sleep(5000);
      if (!live()) return;
      if (session.paused) continue;
      await step("scanning", 500);
      await step("staging-local", 900);
      await step("transitioning", 400);
      // oxlint-enable no-await-in-loop
      if (!live() || session.paused) continue;
      session.status = "watching";
      session.successfulCycles += 1;
      mirrorChanged();
    }
  })();
  return { ...landed, session: session.session };
}

async function labSyncPull(
  local: DeviceForest,
  emit: FixtureWire["emit"],
  input: {
    sourceDeviceId: string;
    sourceProjectId: string;
    sourceWorktreeId: string;
    sourceIdentity: string;
    branch: string;
    runSetup?: boolean;
    ignoreMode?: MirrorSession["ignoreMode"];
  },
) {
  // A posed pull: each step lingers long enough to be seen, and the
  // transfer counts up in chunks like the real one.
  const progress = (frame: Record<string, unknown>) =>
    emit("sync:pullProgress", {
      sourceWorktreeId: input.sourceWorktreeId,
      ...frame,
    });
  // A byte-counted step, counted up in chunks like the real one.
  const countUp = async (
    step: "transfer" | "files",
    totalBytes: number,
    chunk: number,
    ms: number,
  ) => {
    for (let bytes = 0; bytes < totalBytes; bytes += chunk) {
      progress({ step, bytes, totalBytes });
      // oxlint-disable-next-line no-await-in-loop -- a posed transfer
      await sleep(ms);
    }
    progress({ step, bytes: totalBytes, totalBytes });
  };
  progress({ step: "capture" });
  await sleep(900);
  await countUp("transfer", 4_820_000, 640_000, 220);
  progress({ step: "create" });
  await sleep(600);
  const phases = [
    "carryOver",
    ...(input.runSetup === false ? [] : ["setup"]),
    "portPoolProvision",
  ];
  for (const createPhase of phases) {
    progress({ step: "create", createPhase });
    // oxlint-disable-next-line no-await-in-loop -- a posed create
    await sleep(700);
  }
  progress({ step: "apply" });
  await sleep(700);
  // The files step, a leave-out rule that admits something.
  const files = pullBringsIgnoredFiles(input.ignoreMode);
  if (files) await countUp("files", 92_400_000, 11_550_000, 200);
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
  const landed = worktreeFixture({
    ...sourceWorktree,
    id: "fedcba987654",
    projectId: project.id,
    name,
    branch: input.branch,
    path: `/Users/rin/.sm/worktrees/${project.name}/${name}`,
    ahead: sourceWorktree?.ahead ?? 0,
    behind: 0,
    changedCount: sourceWorktree?.changedCount ?? 0,
    recentCommits: sourceWorktree?.recentCommits ?? [],
    // A fresh local checkout, whatever the source's flags said.
    hasRemote: true,
    divergedClean: false,
    behindPrimary: 0,
    mergedIntoPrimary: false,
    isPrimary: false,
    isExternal: false,
    detached: false,
    shelved: false,
    autoPull: false,
  });
  (local.worktrees[project.id] ??= []).push(landed);
  // The real host pings this after any app-driven mutation, and the
  // always-mounted sidebar refreshes off it.
  emit("git:externalChange", undefined);
  return {
    worktree: landed,
    captured: (sourceWorktree?.changedCount ?? 0) > 0,
    dirtyApplied: (sourceWorktree?.changedCount ?? 0) > 0,
    ...(files ? { files: { crossed: true, conflicts: 0 } } : {}),
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

// Three files, so the diff pages pose their file index too (the rail
// beside a wide diff, the bottom sheet on a phone), which needs a
// patch of at least DiffView's INDEX_MIN_FILES.
const LAB_DIFF = `diff --git a/renderer/components/sidebar/RowContent.tsx b/renderer/components/sidebar/RowContent.tsx
index 4f2c9d1..a91f3c7 100644
--- a/renderer/components/sidebar/RowContent.tsx
+++ b/renderer/components/sidebar/RowContent.tsx
@@ -12,6 +12,8 @@ import { WorktreeRowLabel } from "./WorktreeRow";
+import { DeviceBadge } from "./DeviceBadge";
+
 export function RowContent({ row }: { row: SidebarRow }) {
diff --git a/renderer/components/sidebar/DeviceBadge.tsx b/renderer/components/sidebar/DeviceBadge.tsx
new file mode 100644
index 0000000..5b0e77a
--- /dev/null
+++ b/renderer/components/sidebar/DeviceBadge.tsx
@@ -0,0 +1,7 @@
+import { RowTag } from "@/components/ui/row-tag";
+
+// The owning device, as a two-letter tag at the row's trailing edge.
+export function DeviceBadge({ label }: { label: string }) {
+  const short = label.slice(0, 2).toUpperCase();
+  return <RowTag title={label}>{short}</RowTag>;
+}
diff --git a/renderer/components/sidebar/WorktreeRow.tsx b/renderer/components/sidebar/WorktreeRow.tsx
index c3d8e5f..dd44ee5 100644
--- a/renderer/components/sidebar/WorktreeRow.tsx
+++ b/renderer/components/sidebar/WorktreeRow.tsx
@@ -18,7 +18,7 @@ import { useWorktreeRowState } from "./useWorktreeRowState";
 export const WORKTREE_ROW_BUTTON =
-  "group flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs";
+  "group flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs transition-colors";
`;

// ---- lab-mutable account/presence state ----

// Whether Studio Mac accepts commands from the account's other devices
// (the devices page switch on this device's row).
let acceptsCommands = true;
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
      createFixtureWire(
        "host",
        (emit) => hostHandlersFor(forest, emit),
        forest.deviceId,
      ),
    );
  }

  // The web shell has no local forest: its host wire serves nothing, so
  // every host read falls back to the schema stubs (empty lists),
  // matching the real browser bridge's shape.
  const localHost = createFixtureWire(
    "host",
    (emit) =>
      WEB_SHELL
        ? // A browser still keeps its own copy of the shared settings.
          sharedSettingsHandlersFor(WEB_DEVICE_ID, emit)
        : hostHandlersFor(forests[LOCAL_DEVICE_ID], emit),
    "local",
  );

  const registryDevices = () =>
    (WEB_SHELL
      ? [
          ...accountDevices,
          {
            deviceId: WEB_DEVICE_ID,
            name: "Chrome on MacBook",
            platform: WEB_PLATFORM,
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

  // The engine's forward table, mutated by start/stop so the switches
  // on a remote worktree's ports really flip. One forward pre-posed so
  // the live state is visible without a click.
  const forwards = new Map<string, any>([
    [
      "a3f19c2e77b04d5586e1f20c9ab34d61",
      {
        forwardId: "a3f19c2e77b04d5586e1f20c9ab34d61",
        deviceId: THINKPAD_ID,
        remotePort: 5173,
        localPort: 5173,
        connCount: 2,
      },
    ],
  ]);

  const clientHandlers: FixtureHandlers = {
    "account:status": accountStatus,
    "account:listDevices": () => registryDevices(),
    "account:acceptsCommands": () => acceptsCommands,
    "account:setAcceptsCommands": (enabled: boolean) => {
      acceptsCommands = enabled;
      client.emit("account:commandAccessChanged", undefined);
    },
    "account:revokeDevice": (deviceId: string) => {
      // Mirrors the real handler's registry effect: the device leaves
      // the account list and account:changed fans out the refetch.
      // Fixture presence is untouched, matching the device hub's lag.
      revoked.add(deviceId);
      client.emit("account:changed", { accountId: accountStatus().accountId });
    },
    "account:setDeviceName": (name: string) => {
      deviceName = name;
      client.emit("account:changed", { accountId: accountStatus().accountId });
      return accountStatus();
    },
    "account:enroll": () => accountStatus(),
    "account:signOut": () => undefined,
    // ?view=inbox poses the sidebar layout over whatever the lab session
    // has saved, so a shot can open on either view.
    "clientConfig:read": () => {
      const posedView = new URLSearchParams(location.search).get("view");
      let stored: Record<string, unknown> = {};
      try {
        stored = JSON.parse(
          localStorage.getItem("sm.lab.clientConfig") ?? "{}",
        );
      } catch {
        // Corrupt storage reads as defaults.
      }
      return posedView === "inbox" || posedView === "projects"
        ? { ...stored, sidebarView: posedView }
        : stored;
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
    "portForward:list": () => ({ forwards: [...forwards.values()] }),
    "portForward:start": async ({ deviceId, remotePort, localPort }) => {
      await sleep(500);
      const bound = localPort ?? remotePort;
      // One local port posed as taken, so the inline bind error can be
      // seen: node's EADDRINUSE wording, as the engine would pass on.
      if (bound === 3000) {
        throw new Error(
          `listen EADDRINUSE: address already in use 127.0.0.1:${bound}`,
        );
      }
      // The engine's rule: one forward per (device, remote port), and a
      // start naming another local port moves it.
      for (const [id, forward] of forwards) {
        if (
          forward.deviceId === deviceId &&
          forward.remotePort === remotePort
        ) {
          if (forward.localPort === bound)
            return { forwardId: id, localPort: bound };
          forwards.delete(id);
        }
      }
      const forwardId = crypto.randomUUID().replace(/-/g, "");
      forwards.set(forwardId, {
        forwardId,
        deviceId,
        remotePort,
        localPort: bound,
        connCount: 0,
      });
      client.emit("portForward:changed", undefined);
      return { forwardId, localPort: bound };
    },
    "portForward:stop": ({ forwardId }) => {
      forwards.delete(forwardId);
      client.emit("portForward:changed", undefined);
    },
  };

  const client = createFixtureWire("client", () => clientHandlers, "client");
  pushFromPeer = (deviceId, channel) =>
    client.emit("hub:peerPush", { deviceId, channel, payload: undefined });

  const api = {
    deviceId: selfDeviceId,
    appVersion: LAB_APP_VERSION,
    clerkPublishableKey: "pk_test_lab",
    isDev: true,
    isElectron: !WEB_SHELL,
    ...buildApi({ host: localHost.transport, client: client.transport }),
  };
  // The renderer's window.d.ts types window.api as RendererApi
  // (shared/ipc/rendererApi.ts), and the lab bridge satisfies the same
  // runtime surface.
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
    // Holds the given roots still on every posed mirror, each changed
    // on both sides, so the conflict chip and its list can be posed.
    // No roots clears them.
    setMirrorConflicts(roots: string[]) {
      for (const session of labMirrors.sessions) {
        session.conflicts = roots.map((root) => ({
          root,
          localChanges: [{ path: root, kind: "modified" }],
          remoteChanges: [{ path: root, kind: "modified" }],
        }));
      }
      mirrorChanged();
    },
    emitClient: client.emit,
    emitHost: localHost.emit,
  };
}
