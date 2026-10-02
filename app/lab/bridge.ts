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
import type { DeviceIcon } from "@shared/account/deviceIcon";
import type { DeviceInfo } from "@shared/hub/protocol";
import { buildApi, type AllChannelHandlers } from "@shared/ipc/client";
import { stackCleanupForWorktree } from "@shared/pullRequestStack";
import { mergeWorktreePorts } from "@shared/ports/mergeWorktreePorts";
import type {
  Project,
  SharedSettingsDoc,
  ShigomoriWorktreeData,
  Worktree,
} from "@shared/schemas";
import { repoNameFromUrl } from "@shared/cloneUrl";
import { normalizeRemoteUrl } from "@shared/git/repoIdentity.mts";
import {
  createSharedSettingsCopy,
  EMPTY_SHARED_SETTINGS,
} from "@shared/sharedSettings";
import type { ContractScope } from "@shared/ipc/contract";
import { WEB_PLATFORM } from "@shared/account/platform";
import type { HubStatus } from "@shared/ipc/modules/hub";
import {
  MIRROR_HISTORY_LIMIT,
  summarizeIgnores,
} from "@shared/ipc/modules/mirror";
import {
  MOVE_CANCELLED,
  pullBringsIgnoredFiles,
} from "@shared/ipc/modules/sync";
import type { PortForwardSummary } from "@shared/ipc/modules/portForward";
import { pullLandingBranch, pullWorktreeName } from "@shared/git/branches";
import type {
  MirrorEvent,
  MirrorServing,
  MirrorSession,
} from "@shared/ipc/modules/mirror";
import type { ClientTransport } from "@shared/ipc/transport";
import { createSubscriberRegistry } from "@shared/ipc/socket/subscriberRegistry";
import {
  LAB_DIFF,
  LAB_REPO_MERGE_CONFIG,
  labDisableAutoMerge,
  labMergePullRequest,
  labPullRequestDetail,
  labPullRequests,
} from "./pullRequestFixtures";
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
  labReleases,
  labListeningPorts,
  labPoolPorts,
  labRemoteUrls,
  projectIconFor,
  worktree as worktreeFixture,
} from "./fixtures";
import { villagerHandlersFor } from "./villagerData";

// A fixture table: a handler for each channel it answers, typed by the
// contract. A channel the table leaves out falls back to a
// schema-derived stub.
type FixtureHandlers = AllChannelHandlers;

// The posing controls on window.smLab.
interface LabControls {
  setPeer(deviceId: string, state: "connected" | "online" | "offline"): void;
  setSocket(phase: HubStatus["socket"]): void;
  setMirrorConflicts(roots: string[]): void;
  worktree(
    deviceId: string,
    action: "add" | "remove",
    name: string,
    options?: { projectId?: string; changedCount?: number },
  ): void;
  emitClient: FixtureWire["emit"];
  emitHost: FixtureWire["emit"];
  // Set by lab/boot.tsx once the memory router is up.
  navigate?: (to: string) => void;
}

// Present only once the lab bridge is installed, so the renderer
// cannot lean on them.
declare global {
  interface Window {
    smLab?: LabControls;
    smLabLog?: string[];
  }
}

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
  // Read by channel name off the wire, which loses the link between a
  // channel and its input type. The parse below restores it.
  const handlers = handlersFor(emit) as Record<
    string,
    ((input: unknown) => unknown) | undefined
  >;
  return {
    transport: {
      invoke(channel, input) {
        const def = index.get(channel);
        if (def === undefined) {
          return Promise.reject(
            new Error(`[lab] no contract entry for ${channel}`),
          );
        }
        const handler = handlers[channel];
        if (handler !== undefined) {
          // Parsed the way the real registrar parses it, so a handler
          // sees the contract's shape and a bad fixture call fails.
          return Promise.resolve().then(() => handler(def.input.parse(input)));
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
  // Stands in for the restart into the staged build: the device
  // reports up to date.
  const restartIntoUpdate = () => {
    stagedUpdates.delete(forest.deviceId);
    emit("updater:state", { kind: "idle" });
  };
  return {
    ...sharedSettingsHandlersFor(forest.deviceId, emit),
    ...villagerHandlersFor(forest.deviceId),
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
    // Removing really removes, so the row goes and its villager, if it
    // has one, moves out.
    "worktrees:delete": ({ projectId, worktreeId }) => {
      forest.worktrees[projectId] = (forest.worktrees[projectId] ?? []).filter(
        (w) => w.id !== worktreeId,
      );
      return { ok: true };
    },
    // The stack cleanup takes the merged layers' worktrees the way the
    // host does: those of the stack's merged PRs, this device's rows.
    "worktrees:deleteStack": ({ projectId, worktreeId }) => {
      const rows = forest.worktrees[projectId] ?? [];
      const cleanup = stackCleanupForWorktree(
        labPullRequests(projectId),
        rows,
        worktreeId,
      );
      if (!cleanup) {
        throw new Error(
          "No merged layer of this stack has a worktree to remove.",
        );
      }
      const removed = cleanup.worktrees.map((w) => w.id);
      forest.worktrees[projectId] = rows.filter((w) => !removed.includes(w.id));
      return { ok: true, removed };
    },
    "worktrees:listCommits": ({ worktreeId, skip }) =>
      skip > 0 ? [] : (findWorktree(worktreeId)?.recentCommits ?? []),
    "worktrees:fileDiff": () => LAB_DIFF,
    "worktrees:readFile": ({ path }) => labFile(path),
    // A worktree with changes lists two of them, and committing takes
    // them all, so the commit flow runs end to end.
    "worktrees:changeStatus": ({ worktreeId }) =>
      (findWorktree(worktreeId)?.changedCount ?? 0) > 0
        ? [
            {
              path: "renderer/lib/villagerVoice.ts",
              kind: "modified",
              counts: { additions: 12, deletions: 3 },
              staged: "none",
            },
            {
              path: "renderer/lib/toast.tsx",
              kind: "modified",
              counts: { additions: 4, deletions: 1 },
              staged: "none",
            },
          ]
        : [],
    "worktrees:commit": ({ worktreeId }) => {
      const committed = findWorktree(worktreeId);
      if (committed === undefined) throw new Error("Unknown worktree");
      committed.changedCount = 0;
      return { hash: "3f2a1b9", worktree: committed };
    },
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
    // The devices ?updates poses (Thinkpad alone by default) have an
    // update staged, so their Settings sections' restart-to-update
    // buttons have something to show, and the ones ?downloading poses
    // are fetching it. Installing stands in for the restart into the
    // new build: the device reports up to date. Updating one with
    // nothing staged shows the download first.
    "updater:get": () =>
      stagedUpdates.has(forest.deviceId)
        ? { kind: "ready", version: LAB_UPDATE_VERSION, releaseDate: null }
        : downloadingUpdates.has(forest.deviceId)
          ? { kind: "downloading", version: LAB_UPDATE_VERSION }
          : { kind: "idle" },
    "updater:check": () => undefined,
    "updater:install": () => restartIntoUpdate(),
    "updater:update": () => {
      if (stagedUpdates.has(forest.deviceId)) {
        restartIntoUpdate();
        return;
      }
      downloadingUpdates.add(forest.deviceId);
      emit("updater:state", {
        kind: "downloading",
        version: LAB_UPDATE_VERSION,
      });
      setTimeout(() => {
        downloadingUpdates.delete(forest.deviceId);
        emit("updater:state", { kind: "idle" });
      }, 2_500);
    },
    "launchers:detect": () => [...LAB_DETECTED],
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
      launchRow: [],
    }),
    "packageScripts:getSort": () => "manifest",
    "packageScripts:getOrder": () => [],
    "githubCli:readiness": () => ({ installed: true, authed: true }),
    "terrier:readiness": () => ({
      installed: true,
      compatible: true,
      version: "0.4.0",
    }),
    // One repo, one set of PRs: every checkout of shigoto-no-mori
    // answers with the same map, as the real sweep would on each
    // device, so a stack reads the same from every device's rows.
    "githubCli:projectPullRequests": ({ projectId }) =>
      labPullRequests(projectId),
    "githubCli:worktreePullRequest": ({ branch }) =>
      labPullRequestDetail(branch),
    "githubCli:repoMergeConfig": () => LAB_REPO_MERGE_CONFIG,
    // The merge button's outcome, and the PR reading as armed or
    // merged after it, so the flow can be walked in the lab.
    "githubCli:mergePullRequest": ({ method }) => labMergePullRequest(method),
    "githubCli:disablePullRequestAutoMerge": () => labDisableAutoMerge(),
    "sync:worktreeFolder": ({ relative }) => [...(LAB_TREE[relative] ?? [])],
    "sync:ignoredPaths": () => ({
      paths: [...LAB_IGNORED_PATHS],
      total: LAB_IGNORED_PATHS.length,
      patterns: [...LAB_IGNORED_PATHS],
    }),
    // The mirror picture is host-scoped: the forest holding the
    // original reports the session it runs, and the copy's forest the
    // stream it serves. Both refresh off mirror:changed. Copies, since
    // the posed cycle mutates the session in place.
    "mirror:list": () => ({
      daemon: labMirrors.sessions.length > 0 ? "running" : "stopped",
      sessions: labMirrors.sessions
        .filter((session) => labRunners.get(session) === forest.deviceId)
        .map((session) => structuredClone(session)),
      serving: labMirrors.serving
        .filter((stream) => stream.deviceId === forest.deviceId)
        .map(({ deviceId: _device, ...stream }) => stream),
    }),
    "mirror:history": ({ localWorktreeId }) => ({
      events: [...(labMirrors.history[localWorktreeId] ?? [])],
    }),
    // The controls of a session this forest runs (the manage dialog
    // re-scopes to the runner).
    "mirror:stop": ({ session }) => {
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
      const copyForest = entry && forests[entry.deviceId];
      if (entry && copyForest) {
        // The stop takes the copy on the runner's peer with it, as
        // the host's forced delete does.
        copyForest.worktrees[entry.projectId] = (
          copyForest.worktrees[entry.projectId] ?? []
        ).filter((w) => w.id !== entry.worktreeId);
        mirrorWires.get(entry.deviceId)?.("git:externalChange", undefined);
      }
      mirrorChanged();
    },
    "mirror:pause": ({ session }) => setMirrorPaused(session, true),
    "mirror:resume": ({ session }) => setMirrorPaused(session, false),
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
    // "Mirror here" on a peer's worktree: the peer, which holds the
    // original, runs the start and sends the copy to the local forest.
    ...(forest.deviceId === LOCAL_DEVICE_ID
      ? {}
      : {
          "mirror:startTo": (input) => labMirrorStartTo(forest, input),
        }),
    // The cancel, on every forest: the local one for a pull or a send,
    // a peer for the mirror it runs towards here. The posed pull reads
    // the mark between its steps.
    "sync:cancelMove": (input) => {
      const move = posedMoves.get(input.sourceWorktreeId);
      if (move !== undefined) move.cancelled = true;
      return { cancelled: move !== undefined };
    },
    // Local-orchestrator sync verbs, mutating the fixture world so the
    // outcome is visible: the worktree lands in the identity-matched
    // local project, and a teardown removes the source row.
    ...(forest.deviceId === LOCAL_DEVICE_ID
      ? {
          "sync:pullWorktree": (input) => labSyncPull(forest, emit, input),
          // "Mirror here" as the app runs it: the local start asks the
          // forest holding the original to run the mirror towards here.
          "mirror:startFrom": (input) => {
            const runner = forests[input.sourceDeviceId];
            if (runner === undefined) {
              throw new Error("[lab] no such device to mirror from");
            }
            return labMirrorStartTo(runner, {
              targetDeviceId: LOCAL_DEVICE_ID,
              projectId: input.sourceProjectId,
              worktreeId: input.sourceWorktreeId,
              runSetup: input.runSetup,
              ignoreMode: input.ignoreMode,
              ignores: input.ignores,
            });
          },
          "sync:teardownSource": (input) => {
            // The source is the peer's worktree after a pull, this
            // device's own after a send.
            const source =
              input.direction === "pull" ? forests[input.deviceId] : forest;
            if (source !== undefined) {
              source.worktrees[input.projectId] = (
                source.worktrees[input.projectId] ?? []
              ).filter((entry) => entry.id !== input.worktreeId);
            }
            return { sourceRemoved: true };
          },
        }
      : {}),
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// The posed moves under way, by source worktree, and whether each was
// asked to stop, so the dialogs' Cancel has something to cancel here.
const posedMoves = new Map<string, { cancelled: boolean }>();

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

// What the files page's viewer reads for a LAB_TREE file: something
// the highlighter can dress by extension, the .env as the ignored file
// a peer with the grant still reads.
function labFile(path: string) {
  const contents = LAB_FILES[path];
  if (contents === undefined) return { kind: "missing" as const };
  return { kind: "text" as const, contents, size: contents.length };
}

const LAB_FILES: Record<string, string> = {
  ".env": "DATABASE_URL=postgres://localhost:5432/lab\n",
  ".gitignore": "node_modules\ndist\n.env*\n",
  "package.json": `{
  "name": "lab",
  "private": true,
  "type": "module",
  "scripts": { "dev": "vite", "build": "tsc && vite build" }
}
`,
  "README.md": "# Lab\n\nA posed checkout for the files page.\n",
  "src/index.ts": `import { render } from "./components/render";

export function main(root: HTMLElement): void {
  render(root, { greeting: "hello" });
}
`,
};

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
// forest's emitter is remembered so mirror:changed reaches every page,
// a peer's riding the client wire's peer push (installLabBridge).
const labMirrors: {
  sessions: MirrorSession[];
  serving: (MirrorServing & { deviceId: string })[];
  history: Record<string, MirrorEvent[]>;
} = { sessions: [], serving: [], history: {} };
// The forest running each session, the one holding the original.
const labRunners = new WeakMap<MirrorSession, string>();
const mirrorWires = new Map<string, FixtureWire["emit"]>();
let pushFromPeer: (
  deviceId: string,
  channel: string,
  payload: unknown,
) => void = () => {};
let labSessionSerial = 1;

function mirrorChanged() {
  for (const emit of mirrorWires.values()) emit("mirror:changed", undefined);
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

// A posed mirror, run by the forest holding the original: the send
// lands the copy on the local forest, then a session opens on top and
// settles. Afterwards a cycle runs every few seconds so the status is
// seen moving, and the thread gets a conflict once, for the history
// to have more than its start.
async function labMirrorStartTo(
  runner: DeviceForest,
  input: {
    targetDeviceId: string;
    projectId: string;
    worktreeId: string;
    runSetup?: boolean;
    ignoreMode: MirrorSession["ignoreMode"];
    ignores: string[];
  },
) {
  const target = forests[input.targetDeviceId];
  const emit = mirrorWires.get(input.targetDeviceId);
  const project = runner.projects.find((entry) => entry.id === input.projectId);
  const sourceWorktree = (runner.worktrees[input.projectId] ?? []).find(
    (entry) => entry.id === input.worktreeId,
  );
  if (!target || !emit || !project?.identity || !sourceWorktree) {
    throw new Error("[lab] no such worktree to mirror");
  }
  // The rule is the session's, not the send's: a mirror start brings
  // the files through its own session, so the landing poses no files
  // step. A primary's copy lands on its mirror branch and folder.
  const landed = await labSyncPull(target, emit, {
    sourceDeviceId: runner.deviceId,
    sourceProjectId: input.projectId,
    sourceWorktreeId: input.worktreeId,
    sourceIdentity: project.identity,
    branch: sourceWorktree.branch,
    landBranch: pullLandingBranch(sourceWorktree),
    worktreeName: pullWorktreeName(sourceWorktree),
    runSetup: input.runSetup,
  });
  const tip = sourceWorktree.recentCommits[0]?.hash.slice(0, 7) ?? "58c21fe";
  const session: MirrorSession = {
    session: `sync_${labSessionSerial++}`,
    name: sourceWorktree.branch,
    labels: { copySide: "remote" },
    localRoot: sourceWorktree.path,
    localProjectId: input.projectId,
    localWorktreeId: input.worktreeId,
    deviceId: input.targetDeviceId,
    projectId: landed.worktree.projectId,
    worktreeId: landed.worktree.id,
    remoteRoot: landed.worktree.path,
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
  labRunners.set(session, runner.deviceId);
  labMirrors.serving.push({
    deviceId: input.targetDeviceId,
    channelId: "a1b2c3d4e5f60718293a4b5c6d7e8f90",
    projectId: landed.worktree.projectId,
    worktreeId: landed.worktree.id,
    peerDeviceId: runner.deviceId,
    peerWorktreeId: input.worktreeId,
    since: Date.now(),
  });
  noteMirrorEvent(
    input.worktreeId,
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
    noteMirrorEvent(input.worktreeId, "connected", "");
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
    // The copy's branch and folder when they are not the source's.
    landBranch?: string;
    worktreeName?: string;
    runSetup?: boolean;
    ignoreMode?: MirrorSession["ignoreMode"];
  },
) {
  // A posed pull: each step lingers long enough to be seen, and the
  // transfer counts up in chunks like the real one. A cancel lands
  // between two of its waits, and the pull fails as the real one does.
  const progress = (frame: Record<string, unknown>) =>
    emit("sync:pullProgress", {
      sourceWorktreeId: input.sourceWorktreeId,
      ...frame,
    });
  const move = { cancelled: false };
  const wait = async (ms: number) => {
    await sleep(ms);
    if (move.cancelled) throw new Error(MOVE_CANCELLED);
  };
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
      await wait(ms);
    }
    progress({ step, bytes: totalBytes, totalBytes });
  };
  const files = pullBringsIgnoredFiles(input.ignoreMode);
  posedMoves.set(input.sourceWorktreeId, move);
  try {
    progress({ step: "capture" });
    await wait(900);
    await countUp("transfer", 4_820_000, 640_000, 220);
    progress({ step: "create" });
    await wait(600);
    const phases = [
      "carryOver",
      ...(input.runSetup === false ? [] : ["setup"]),
      "portPoolProvision",
    ];
    for (const createPhase of phases) {
      progress({ step: "create", createPhase });
      // oxlint-disable-next-line no-await-in-loop -- a posed create
      await wait(700);
    }
    progress({ step: "apply" });
    await wait(700);
    // The files step, a leave-out rule that admits something.
    if (files) await countUp("files", 92_400_000, 11_550_000, 200);
  } finally {
    posedMoves.delete(input.sourceWorktreeId);
  }
  const project = local.projects.find(
    (entry) => entry.identity === input.sourceIdentity,
  );
  if (project === undefined) throw new Error("[lab] no identity match");
  const source = forests[input.sourceDeviceId];
  const sourceList = source?.worktrees[input.sourceProjectId] ?? [];
  const sourceWorktree = sourceList.find(
    (entry) => entry.id === input.sourceWorktreeId,
  );
  const name = input.worktreeName ?? sourceWorktree?.name ?? "tender-tanuki";
  const landed = worktreeFixture({
    ...sourceWorktree,
    id: "fedcba987654",
    projectId: project.id,
    name,
    branch: input.landBranch ?? input.branch,
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

// ---- lab-mutable account/presence state ----

// Whether Studio Mac accepts commands from the account's other devices
// (the devices page switch on this device's row).
let acceptsCommands = true;
// Devices revoked in this lab session: the fixture registry is static,
// so the revoke handler records the id here and the list filters it.
const revoked = new Set<string>();
let deviceName = "Studio Mac";
// This device's icon pick: null is "what it detected",
// which depends on the shell posed (set at install, so read late).
let deviceIcon: DeviceIcon | null = null;
const detectedIcon = (): DeviceIcon => (WEB_SHELL ? "browser" : "mini");
// A peer's registry entry, where a rename or icon pick made for it
// lands, as the hub write would.
const peerEntry = (deviceId: string) =>
  accountDevices.find((device) => device.deviceId === deviceId);

// The web-shell pose (lab/web-main.tsx): this page is an enrolled
// BROWSER device, every machine forest (Studio Mac included) is a
// peer, and nothing is local. Passed into installLabBridge rather than
// read from a global, since import hoisting evaluates this module
// before any entry-file code runs.
let WEB_SHELL = false;
const WEB_DEVICE_ID = "dev_beefcafe01";
// Village life on in this window's client config: ?villageLife=1, or
// the villager contact sheet's say. Off otherwise, as a fresh install
// has it. The villager data itself is lab/villagerData.ts.
let villageLife = false;

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
// ?updates=sm,tp,mini: the devices holding a staged update, and
// ?downloading=sm,tp,mini the ones fetching it.
const stagedUpdates = new Set<string>();
const downloadingUpdates = new Set<string>();
const LAB_UPDATE_VERSION = "2.1.0";

function initPresence(): void {
  const pose = new URLSearchParams(location.search);
  const posed = pose.get("peers");
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
  posedDevices(pose.get("updates") ?? "tp", stagedUpdates);
  posedDevices(pose.get("downloading") ?? "", downloadingUpdates);
}

// ?crowd=<n>: that many more projects on Studio Mac, for the forest at
// the size where finding a project gets hard. Most hold their primary
// checkout alone, the way most real ones do, and every fourth has a
// worktree or two in flight. With ?crowdShared=1 terrier lists them
// all and most are cloned on the Thinkpad too, the way a registry kept
// on every machine fills the list: nearly every project then carries a
// paw and a device, which the open project's header shows.
const CROWD_NAMES = [
  "lichen",
  "terrier",
  "whatagain",
  "dropcube",
  "headroom",
  "songloupe",
  "picto-place",
  "leatcer",
  "mise-en-scene",
  "rm-to-trash",
  "daramdrop",
  "agent-snippets",
  "celery",
  "lookout",
  "previewer",
  "powder-game",
  "website",
  "skills",
  "tuneloupe",
  "fileatlas",
];
const CROWD_ANIMALS = ["sly-stoat", "plain-plover"];

function initCrowd(): void {
  const pose = new URLSearchParams(location.search);
  const posed = Number(pose.get("crowd"));
  const local = forests[LOCAL_DEVICE_ID];
  if (!Number.isInteger(posed) || posed <= 0 || local === undefined) return;
  const thinkpad =
    pose.get("crowdShared") === "1" ? forests[THINKPAD_ID] : undefined;
  const shared = thinkpad !== undefined;
  CROWD_NAMES.slice(0, posed).forEach((name, i) => {
    // One checkout of the crowd's project on a device, its primary
    // worktree first and the given ones after it.
    const checkout = (
      forest: DeviceForest,
      id: string,
      path: string,
      extra: (id: string) => Worktree[] = () => [],
    ) => {
      forest.projects.push({
        id,
        name,
        path,
        pathExists: true,
        identity: shared ? `root:crowd${String(i).padStart(12, "0")}` : null,
        source: shared ? "terrier" : undefined,
        lastUsed: Date.now() - (i + 6) * 86_400_000,
        recentCount: 1,
      });
      forest.worktrees[id] = [
        worktreeFixture({
          id: `wt_${id}`,
          projectId: id,
          name,
          branch: "main",
          path,
          isPrimary: true,
        }),
        ...extra(id),
      ];
    };
    checkout(local, `p_crowd_${i}`, `/Users/rin/dev/${name}`, (id) =>
      CROWD_ANIMALS.slice(0, i % 8 === 0 ? 1 : i % 4 === 0 ? 2 : 0).map(
        (animal, n) =>
          worktreeFixture({
            id: `wt_crowd_${i}_${n}`,
            projectId: id,
            name: animal,
            branch: n === 0 ? "fix-flaky-sync" : "exp/redo-cache",
            path: `/Users/rin/.sm/worktrees/${name}/${animal}`,
          }),
      ),
    );
    // Every fifth stays on this machine alone, so the projects differ.
    if (shared && i % 5 !== 4) {
      checkout(thinkpad, `tp_crowd_${i}`, `/home/rin/dev/${name}`);
    }
  });
}

// A pose's comma-separated device keys, into their ids.
function posedDevices(keys: string, into: Set<string>): void {
  for (const key of keys.split(",")) {
    const id = PEER_KEYS[key.trim()];
    if (id !== undefined) into.add(id);
  }
}
let socketPhase: HubStatus["socket"] = {
  phase: "connected",
  remoteDeviceId: "",
  remoteAppVersion: "",
};

function hubSnapshot(): HubStatus {
  const peerAppVersions: Record<string, string> = {};
  const peerAcceptsCommands: Record<string, boolean> = {};
  for (const id of directSessions) {
    peerAppVersions[id] = LAB_APP_VERSION;
    peerAcceptsCommands[id] = forests[id]?.grantsCaller ?? false;
  }
  return {
    socket: socketPhase,
    onlineDeviceIds: [...roster],
    peerAppVersions,
    peerAcceptsCommands,
    tunnel: "up",
  };
}

export function installLabBridge(
  opts: { webShell?: boolean; villageLife?: boolean } = {},
) {
  WEB_SHELL = opts.webShell === true;
  villageLife =
    opts.villageLife ??
    new URLSearchParams(location.search).get("villageLife") === "1";
  initPresence();
  initCrowd();
  // Remote hosts: one fixture wire per device, reached only through
  // hub:invokePeer exactly like the real hub bridge, and broadcasting
  // the way it delivers a peer's: as a peer push on the client wire.
  // Under the web shell every machine forest (Studio Mac included) is
  // a peer of the browser device, while on desktop Studio Mac is the
  // local host.
  const selfDeviceId = WEB_SHELL ? WEB_DEVICE_ID : LOCAL_DEVICE_ID;
  const peerWires = new Map<string, FixtureWire>();
  for (const forest of Object.values(forests)) {
    if (forest.deviceId === selfDeviceId) continue;
    peerWires.set(
      forest.deviceId,
      createFixtureWire(
        "host",
        () =>
          hostHandlersFor(forest, (channel, payload) =>
            pushFromPeer(forest.deviceId, channel, payload),
          ),
        forest.deviceId,
      ),
    );
  }

  // The web shell has no local forest: its host wire serves nothing, so
  // every host read falls back to the schema stubs (empty lists),
  // matching the real browser bridge's shape.
  const localForest = forests[LOCAL_DEVICE_ID];
  if (localForest === undefined) throw new Error("[lab] no local forest");
  const localHost = createFixtureWire(
    "host",
    (emit) =>
      WEB_SHELL
        ? // A browser still keeps its own copy of the shared settings.
          sharedSettingsHandlersFor(WEB_DEVICE_ID, emit)
        : hostHandlersFor(localForest, emit),
    "local",
  );

  const webDevice: DeviceInfo = {
    deviceId: WEB_DEVICE_ID,
    name: "Chrome on MacBook",
    platform: WEB_PLATFORM,
    icon: "browser",
    createdAt: Date.now() - 2 * 24 * 3_600_000,
    lastSeenAt: Date.now(),
    online: true,
  };
  const registryDevices = () =>
    (WEB_SHELL ? [...accountDevices, webDevice] : accountDevices).filter(
      (device) => !revoked.has(device.deviceId),
    );

  // ?signedOut=1 poses the desktop signed out (the web shell has no
  // signed-out window to show), for the settings that need an account.
  const signedOut =
    !WEB_SHELL && new URLSearchParams(location.search).get("signedOut") === "1";
  const accountStatus = () => ({
    configured: true,
    signedIn: !signedOut,
    accountId: signedOut ? "" : LAB_ACCOUNT_ID,
    deviceName: WEB_SHELL ? "Chrome on MacBook" : deviceName,
    deviceIcon: deviceIcon ?? detectedIcon(),
    detectedDeviceIcon: detectedIcon(),
    sharedSignIn: false,
  });

  // The engine's forward table, mutated by start/stop so the switches
  // on a remote worktree's ports really flip. One forward pre-posed so
  // the live state is visible without a click.
  const forwards = new Map<string, PortForwardSummary>([
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
    "account:setAcceptsCommands": (enabled) => {
      acceptsCommands = enabled;
      client.emit("account:commandAccessChanged", enabled);
    },
    "account:revokeDevice": (deviceId) => {
      // Mirrors the real handler's registry effect: the device leaves
      // the account list and account:changed fans out the refetch.
      // Fixture presence is untouched, matching the device hub's lag.
      revoked.add(deviceId);
      client.emit("account:changed", { accountId: accountStatus().accountId });
    },
    "account:setDeviceName": ({
      deviceId,
      name,
    }: {
      deviceId: string;
      name: string;
    }) => {
      if (deviceId === selfDeviceId) {
        deviceName = name;
      } else {
        const entry = peerEntry(deviceId);
        if (entry !== undefined) entry.name = name;
      }
      client.emit("account:changed", { accountId: accountStatus().accountId });
      return accountStatus();
    },
    "account:setDeviceIcon": ({
      deviceId,
      icon,
    }: {
      deviceId: string;
      icon: DeviceIcon;
    }) => {
      if (deviceId === selfDeviceId) {
        // The store's rule: the detected icon is no pick.
        deviceIcon = icon === detectedIcon() ? null : icon;
      } else {
        const entry = peerEntry(deviceId);
        if (entry !== undefined) entry.icon = icon;
      }
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
      // The web shell has no Village life to pose.
      const posed =
        villageLife && !WEB_SHELL ? { ...stored, villageLife } : stored;
      return posedView === "inbox" || posedView === "projects"
        ? { ...posed, sidebarView: posedView }
        : posed;
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
    "releases:list": () => labReleases,
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
  pushFromPeer = (deviceId, channel, payload) =>
    client.emit("hub:peerPush", { deviceId, channel, payload });

  const api = {
    deviceId: selfDeviceId,
    appVersion: LAB_APP_VERSION,
    clerkPublishableKey: "pk_test_lab",
    isDev: true,
    isElectron: !WEB_SHELL,
    ...buildApi({ host: localHost.transport, client: client.transport }),
  };
  // The renderer's window.d.ts types window.api off the preload, so
  // this assignment is the proof the lab bridge has the same surface.
  window.api = api;

  const pushHub = () => client.emit("hub:statusChanged", hubSnapshot());

  window.smLab = {
    setPeer(deviceId, state) {
      roster.delete(deviceId);
      directSessions.delete(deviceId);
      if (state !== "offline") roster.add(deviceId);
      if (state === "connected") directSessions.add(deviceId);
      pushHub();
    },
    setSocket(phase) {
      socketPhase = phase;
      pushHub();
    },
    // Holds the given roots still on every posed mirror, each changed
    // on both sides, so the conflict chip and its list can be posed.
    // No roots clears them.
    setMirrorConflicts(roots) {
      for (const session of labMirrors.sessions) {
        session.conflicts = roots.map((root) => ({
          root,
          localChanges: [{ path: root, kind: "modified" }],
          remoteChanges: [{ path: root, kind: "modified" }],
        }));
      }
      mirrorChanged();
    },
    // A worktree created or removed behind the app's back, the way
    // `sm` in a terminal (this device) or another device's user does
    // it: the fixture world moves, then the host says so the way its fs
    // watcher would. `projectId` defaults to the device's first
    // project, and `changedCount` gives an added one changes to commit.
    worktree(deviceId, action, name, { projectId, changedCount = 0 } = {}) {
      const forest = forests[deviceId];
      if (forest === undefined) throw new Error(`[lab] no device ${deviceId}`);
      const project =
        forest.projects.find((p) => p.id === projectId) ?? forest.projects[0];
      if (project === undefined) {
        throw new Error(`[lab] no project on ${deviceId} to put ${name} in`);
      }
      const list = (forest.worktrees[project.id] ??= []);
      if (action === "add") {
        list.push(
          worktreeFixture({
            id: `lab${Date.now().toString(36)}${name}`,
            projectId: project.id,
            name,
            branch: name,
            path: `${project.path}/../worktrees/${name}`,
            hasUpstream: false,
            changedCount,
          }),
        );
      } else {
        forest.worktrees[project.id] = list.filter((w) => w.name !== name);
      }
      if (deviceId === selfDeviceId) {
        localHost.emit("git:externalChange", undefined);
      } else {
        pushFromPeer(deviceId, "git:externalChange", undefined);
      }
    },
    emitClient: client.emit,
    emitHost: localHost.emit,
  };
}
