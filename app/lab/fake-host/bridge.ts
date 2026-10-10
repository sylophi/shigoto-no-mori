// The fake host's window.api: the same surface the desktop builds,
// served entirely from fixtures.ts. The real renderer
// boots on top of it unmodified: startRemoteDeviceSync, HostScope, the
// sidebar tree and every remote view all derive from these answers
// exactly as they would from a live device hub. Channels no fixture
// handler covers fall back to schema-derived stubs (fabricated arms
// allowed: this is a design tool, not a product surface).
//
// window.fakeHost carries the posing controls: flip a peer's presence,
// change the socket phase, navigate the memory router.
import { normalizeRemoteUrl } from "@shigomori/contracts/predicates/remoteUrl";
import {
  NotSharingError,
  UnknownProjectError,
  UnknownWorktreeError,
} from "@shigomori/contracts/errors";
import type * as Types from "effect/Types";
import type { DeviceIcon } from "@shigomori/contracts/deviceIcon";
import type { DeviceInfo } from "@shigomori/contracts/hubProtocol";
import type { AllChannelHandlers } from "@shared/ipc/client";
import { stackCleanupForWorktree } from "@shigomori/contracts/pullRequestStack";
import { mergeWorktreePorts } from "@shared/ports/mergeWorktreePorts";
import type {
  Project,
  RunningScript,
  SharedSettingsDoc,
  ShigomoriWorktreeData,
  Worktree,
} from "@shigomori/contracts/schemas";
import { cloneFolderName } from "@shared/cloneUrl";
import {
  createSharedSettingsCopy,
  EMPTY_SHARED_SETTINGS,
} from "@shigomori/contracts/sharedSettings";
import {
  type ContractScope,
  inputOf,
  outputOf,
  scopeOf,
} from "@shigomori/contracts/contract";
import { decode } from "@shigomori/contracts/codec";
import { WEB_PLATFORM } from "@shigomori/contracts/platform";
import type { HubStatus } from "@shigomori/contracts/modules/hub";
import type { AgentHarnessStatus } from "@shigomori/contracts/schemas";
import type { MigrationProgress } from "@shigomori/contracts/schemas/migration";
import {
  MIRROR_HISTORY_LIMIT,
  summarizeIgnores,
} from "@shigomori/contracts/modules/mirror";
import {
  MOVE_CANCELLED,
  pullBringsIgnoredFiles,
} from "@shigomori/contracts/modules/sync";
import type { PortForwardSummary } from "@shigomori/contracts/modules/portForward";
import {
  pullLandingBranch,
  pullWorktreeName,
} from "@shigomori/contracts/git/branches";
import type {
  MirrorEvent,
  MirrorServing,
  MirrorSession,
} from "@shigomori/contracts/modules/mirror";
import type { Link } from "@shared/ipc/transport";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { ClientLinks } from "@/lib/runtime/ClientLinks";
import { disposeWithPage, startClientNow } from "@/lib/runtime/client";
import { pushFanOut } from "@shared/remote/rpcTransport";
import {
  FAKE_DIFF,
  FAKE_REPO_MERGE_CONFIG,
  fakeDisableAutoMerge,
  fakeMergePullRequest,
  fakePullRequestDetail,
  fakePullRequests,
} from "@shigomori/ui/fixtures/pullRequestFixtures.ts";
import { createFakeChanges } from "@shigomori/ui/fixtures/changesFixtures.ts";
import { FAKE_TREE, fakeFile } from "@shigomori/ui/fixtures/filesFixtures.ts";
import { invokeIndexFor } from "../../web/ipc/localRegistrar";
import { NO_STRUCTURAL_STUB, stubValueFor } from "../../web/ipc/stubDefaults";
import {
  type DeviceForest,
  type FakeDisk,
  FAKE_ACCOUNT_ID,
  FAKE_APP_VERSION,
  LOCAL_DEVICE_ID,
  MINI_ID,
  THINKPAD_ID,
  WORKPC_ID,
  accountDevices,
  forests,
  fakeCustomPorts,
  fakeDisks,
  fakeGlobalConfig,
  fakeReleases,
  fakeListeningPorts,
  fakePoolPorts,
  fakeRemoteUrls,
  fakeRunningScripts,
  fakeStashes,
  addLiveEdgeRuns,
  repoDescriptionFor,
  type FakeWorktree,
  worktree as worktreeFixture,
} from "@shigomori/ui/fixtures/fixtures.ts";
import { endpointState } from "@shigomori/ui/fixtures/mirrorFixtures.ts";
import {
  MIGRATION_POSES,
  type MigrationPose,
} from "@shigomori/ui/fixtures/stepsFixtures.ts";
import {
  FAKE_DETECTED,
  FAKE_LAUNCHERS,
  fakeAgentHarnesses,
} from "@shigomori/ui/fixtures/settingsFixtures.ts";
import { villagerHandlersFor } from "./villagerData";

// A worktree id the contracts accept (12 hex), the same for the same
// seed: FNV-1a over it, twice with different offsets for 48 bits.
function worktreeIdOf(seed: string): string {
  const half = (offset: number) => {
    let hash = offset;
    for (let i = 0; i < seed.length; i++) {
      hash = Math.imul(hash ^ seed.charCodeAt(i), 16777619) >>> 0;
    }
    return (hash & 0xffffff).toString(16).padStart(6, "0");
  };
  return half(2166136261) + half(84696351);
}

// A fixture table: a handler for each channel it answers, typed by the
// contract. A channel the table leaves out falls back to a
// schema-derived stub.
type FixtureHandlers = AllChannelHandlers;

// The posing controls on window.fakeHost.
interface FakeHostControls {
  setPeer(deviceId: string, state: "connected" | "online" | "offline"): void;
  setSocket(phase: HubStatus["socket"]): void;
  setMirrorConflicts(roots: string[]): void;
  worktree(
    deviceId: string,
    action: "add" | "update" | "remove",
    name: string,
    options?: {
      projectId?: string;
      changedCount?: number;
      // Any other row fields, for posing a git state (`detached`,
      // `hasUpstream`, `behind`, …) on an added or an existing row.
      fields?: Partial<Worktree>;
    },
  ): void;
  emitClient: FixtureWire["emit"];
  emitHost: FixtureWire["emit"];
  // Set by boot.tsx once the memory router is up.
  navigate?: (to: string) => void;
}

// Present only once the fake host bridge is installed, so the renderer
// cannot lean on them.
declare global {
  interface Window {
    fakeHost?: FakeHostControls;
  }
}

type FixtureWire = {
  link: Link;
  // A call's answer, for the hub hop's fixture (hub:invokePeer), after
  // which `touch` has the wire's views read again, as a call over its
  // link does.
  answer: (channel: string, input: unknown) => Promise<unknown>;
  touch: () => void;
  emit: (channel: string, payload: unknown) => void;
};

// Handlers are built from the wire's own emitter, so a fixture that
// streams (the pull's progress frames) broadcasts on the wire it
// answers on.
function createFixtureWire(
  scope: ContractScope,
  handlersFor: (emit: FixtureWire["emit"]) => FixtureHandlers,
  // A view the wire serves itself (the hub hop's), in place of the one
  // emulated below.
  ownView?: (
    channel: string,
    input: unknown,
  ) => Stream.Stream<unknown, unknown> | undefined,
): FixtureWire {
  const fanOut = pushFanOut();
  const index = invokeIndexFor(scope);
  // Every push on the wire, whatever its channel, for the views.
  const moved = new Set<() => void>();
  const emit: FixtureWire["emit"] = (channel, payload) => {
    fanOut.emit(channel, payload);
    for (const listener of moved) listener();
  };
  // Read by channel name off the wire, which loses the link between a
  // channel and its input type. The parse below restores it.
  const handlers = handlersFor(emit) as Record<
    string,
    ((input: unknown) => unknown) | undefined
  >;
  const answer = async (channel: string, input: unknown) => {
    const call = index.get(channel);
    if (call === undefined) {
      throw new Error(`[fake-host] no contract entry for ${channel}`);
    }
    const handler = handlers[channel];
    if (handler !== undefined) {
      // Parsed the way the real registrar parses it, so a handler sees
      // the contract's shape and a bad fixture call fails. The answer is
      // copied the way the real wire's serializing copies it, so
      // handlers can hand back the fixture world's own rows and change
      // them in place later: a cached answer that is the same object as
      // the next one would never look changed.
      return structuredClone(await handler(decode(inputOf(call), input)));
    }
    const stub = stubValueFor(outputOf(call), { fabricateArms: true });
    if (stub === NO_STRUCTURAL_STUB) {
      throw new Error(`[fake-host] no stub for ${channel}`);
    }
    return stub;
  };
  return {
    // The lab's own fixtures, local and peer alike, read as given. What
    // a fixture rejects with (a posed contract error) is the call's
    // failure as it is.
    link: {
      local: true,
      // A call may move the fixture world the way a host's store write
      // does, so the views read again after it.
      call: (channel, input) =>
        Effect.callback<unknown, unknown>((resume) => {
          answer(channel, input).then(
            (value) => {
              resume(Effect.succeed(value));
              for (const listener of moved) listener();
            },
            (error: unknown) => resume(Effect.fail(error)),
          );
        }),
      // A host view (host/lib/views.ts) re-reads the query beside it on
      // what moved: here, the module's list (or its settings' read) on
      // any push or call on the wire, sent on when it changed.
      view: (channel, input) => {
        const own = ownView?.(channel, input);
        if (own !== undefined) return own;
        const module = channel.slice(0, channel.indexOf(":"));
        const query = [`${module}:list`, `${module}:read`].find(
          (candidate) => candidate !== channel && index.has(candidate),
        );
        if (query === undefined) {
          return Stream.die(
            new Error(`[fake-host] no fixture serves ${channel}`),
          );
        }
        const pushes = Stream.callback<void>((queue) =>
          Effect.acquireRelease(
            Effect.sync(() => {
              const listener = () => {
                Queue.offerUnsafe(queue, undefined);
              };
              moved.add(listener);
              return listener;
            }),
            (listener) => Effect.sync(() => moved.delete(listener)),
          ),
        );
        return Stream.concat(Stream.make(undefined), pushes).pipe(
          Stream.mapEffect(() => Effect.promise(() => answer(query, input))),
          Stream.changesWith((a, b) => JSON.stringify(a) === JSON.stringify(b)),
        );
      },
      pushes: fanOut.pushes,
    },
    answer,
    touch: () => {
      for (const listener of moved) listener();
    },
    emit,
  };
}

// ---- per-device host fixtures ----

// One device's copy of the shared settings, in memory, over the real
// copy rule, so a pick made in the fake host stamps, announces and converges
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
function resolveOnDisk(disk: FakeDisk, path: string): string {
  const expanded =
    path === "~" || path.startsWith("~/") ? disk.home + path.slice(1) : path;
  return expanded.length > 1 ? expanded.replace(/\/+$/, "") : expanded;
}

function isRepoOnDisk(disk: FakeDisk, path: string): boolean {
  const cut = path.lastIndexOf("/");
  return (disk.dirs[path.slice(0, cut) || "/"] ?? []).some(
    (entry) => entry.name === path.slice(cut + 1) && entry.isGitRepo,
  );
}

// What registering a checkout does to the fixture world: the project
// joins the device's list with a primary worktree on main, so the add
// flow has somewhere to land and the sidebar shows it.
function registerProject(
  disk: FakeDisk,
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
    id: `fake_${forest.projects.length}_${name}`,
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
      id: worktreeIdOf(`${project.id} main`),
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
  const disk = fakeDisks[forest.deviceId] ?? { home: "/home/rin", dirs: {} };
  mirrorWires.set(forest.deviceId, emit);
  // The worktree data files, seeded from the fixtures and mutated by
  // worktreeData:write so adding and removing ports shows its outcome.
  const worktreeData = new Map<string, ShigomoriWorktreeData>(
    Object.entries(fakeCustomPorts).map(([id, ports]) => [id, { ports }]),
  );
  const allWorktrees = () => Object.values(forest.worktrees).flat();
  // Claude Code's hooks in, Codex's waiting on a fresh install.
  let agentHarnesses = fakeAgentHarnesses(disk.home);
  const findWorktree = (worktreeId: string) =>
    allWorktrees().find((worktree) => worktree.id === worktreeId);
  const changes = createFakeChanges(findWorktree);
  const syncAfter = async (
    worktreeId: string,
    move: (worktree: FakeWorktree) => void,
  ): Promise<Worktree> => {
    await sleep(700);
    const worktree = findWorktree(worktreeId);
    if (!worktree) throw new UnknownWorktreeError({ worktreeId });
    move(worktree);
    return worktree;
  };
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
    ...villagerHandlersFor(),
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
      const folder = name ?? cloneFolderName(url) ?? "repo";
      if (entries.some((entry) => entry.name === folder)) {
        throw new Error(`${parent}/${folder} already exists`);
      }
      entries.push({ name: folder, isGitRepo: true });
      const identity =
        Object.entries(fakeRemoteUrls).find(
          ([, known]) => normalizeRemoteUrl(known) === normalizeRemoteUrl(url),
        )?.[0] ?? `remote:${normalizeRemoteUrl(url)}`;
      return registerProject(disk, forest, `${parent}/${folder}`, identity);
    },
    // Quick, as a new repository is, but long enough to see the stage.
    "projects:create": async ({ parentDir, name }) => {
      await sleep(600);
      const parent = resolveOnDisk(disk, parentDir);
      const entries = disk.dirs[parent];
      if (entries === undefined) throw new Error(`${parent} is not a folder`);
      if (entries.some((entry) => entry.name === name)) {
        throw new Error(`${parent}/${name} already exists`);
      }
      entries.push({ name, isGitRepo: true });
      return registerProject(disk, forest, `${parent}/${name}`);
    },
    // Points the project at a repo on the fake disk, the primary row
    // with it, so a missing project (?missing=1) comes back.
    "projects:relocate": ({ id, path }) => {
      const resolved = resolveOnDisk(disk, path);
      if (!isRepoOnDisk(disk, resolved)) {
        throw new Error(`${resolved} is not a git repository`);
      }
      const taken = forest.projects.find((entry) => entry.path === resolved);
      if (taken !== undefined) {
        throw new Error(`${resolved} is already registered as ${taken.name}`);
      }
      const at = forest.projects.findIndex((entry) => entry.id === id);
      const before = forest.projects[at];
      if (before === undefined)
        throw new UnknownProjectError({ projectId: id });
      // New objects, not edits: the query cache holds the old ones, and
      // an edit in place would read to it as nothing changed.
      const project = {
        ...before,
        name: resolved.slice(resolved.lastIndexOf("/") + 1),
        path: resolved,
        pathExists: true,
      };
      forest.projects[at] = project;
      const worktrees = forest.worktrees[id] ?? [];
      const primary = worktrees.findIndex((worktree) => worktree.isPrimary);
      const primaryRow = worktrees[primary];
      if (primaryRow !== undefined) {
        worktrees[primary] = {
          ...primaryRow,
          name: project.name,
          path: resolved,
        };
      }
      return project;
    },
    "projects:cloneUrl": ({ projectId }) => {
      const identity = forest.projects.find(
        (project) => project.id === projectId,
      )?.identity;
      return identity ? (fakeRemoteUrls[identity] ?? null) : null;
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
    // No fixture repo has an icon, so every project wears the app's
    // letter tile, as the scenes draw it.
    "projects:icon": () => null,
    "worktrees:list": ({ projectId }) => forest.worktrees[projectId] ?? [],
    "worktrees:idleAgents": ({ worktreeId }) => {
      const worktree = findWorktree(worktreeId);
      if (!worktree) throw new Error("Unknown worktree");
      worktree.agentWorking = false;
      worktree.agentSessions = worktree.agentSessions?.map((session) => ({
        ...session,
        state: "idle",
        at: Date.now(),
      }));
      return worktree;
    },
    "worktrees:unbindAgent": ({ worktreeId, harness, session }) => {
      const worktree = findWorktree(worktreeId);
      if (!worktree) throw new Error("Unknown worktree");
      worktree.agentSessions = worktree.agentSessions?.filter(
        (s) => s.harness !== harness || s.session !== session,
      );
      worktree.agentWorking =
        worktree.agentSessions?.some((s) => s.state === "working") ?? false;
      return worktree;
    },
    "worktrees:resumeAgent": () => undefined,
    "agents:status": () => agentHarnesses,
    "agents:setHooks": async ({ harness, install }) => {
      await sleep(400);
      agentHarnesses = setHooks(
        agentHarnesses,
        harness,
        install ? "installed" : "missing",
      );
      return agentHarnesses;
    },
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
        fakePullRequests(projectId),
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
    // A rename moves the folder, so the row comes back under a new id,
    // as the host's does, and what the fixtures keep by the old id
    // stays there.
    "worktrees:rename": ({ projectId, worktreeId, name }) => {
      const rows = forest.worktrees[projectId] ?? [];
      const row = rows.find((w) => w.id === worktreeId);
      if (!row) throw new Error("That worktree is gone.");
      if (rows.some((w) => w.id !== worktreeId && w.name === name)) {
        throw new Error(
          `A worktree folder named "${name}" already exists in this project.`,
        );
      }
      const renamed = {
        ...row,
        // A 12-hex id of the new path, as the host's is.
        id: [...`${worktreeId}/${name}`]
          .reduce((hash, c) => (hash * 31 + c.charCodeAt(0)) >>> 0, 7)
          .toString(16)
          .padStart(12, "0"),
        name,
        path: `${row.path.slice(0, row.path.lastIndexOf("/"))}/${name}`,
      };
      forest.worktrees[projectId] = rows.map((w) =>
        w.id === worktreeId ? renamed : w,
      );
      return renamed;
    },
    "worktrees:listCommits": ({ worktreeId, skip }) =>
      skip > 0 ? [] : (findWorktree(worktreeId)?.recentCommits ?? []),
    "worktrees:fileDiff": ({ worktreeId, paths }) =>
      changes.fileDiff(worktreeId, paths),
    "worktrees:readFile": ({ path }) => fakeFile(path),
    // The working tree is kept per worktree (changesFixtures.ts), so
    // committing and discarding show their outcome, and a commit leaves
    // something to push.
    "worktrees:changeStatus": ({ worktreeId }) => changes.status(worktreeId),
    "worktrees:commit": ({ worktreeId, summary, paths, hunks, amend }) =>
      changes.commit(worktreeId, { summary, paths, hunks, amend }),
    "worktrees:discardChanges": ({ worktreeId, paths }) =>
      changes.discard(worktreeId, paths),
    // The sync verbs move the counts the way the real ones would, after
    // a beat so their pending state shows.
    "worktrees:push": ({ worktreeId }) => syncAfter(worktreeId, pushed),
    "worktrees:publish": ({ worktreeId }) =>
      syncAfter(worktreeId, (w) => {
        w.hasUpstream = true;
        pushed(w);
      }),
    "worktrees:pull": ({ worktreeId }) =>
      syncAfter(worktreeId, (w) => {
        w.behind = 0;
      }),
    "worktrees:pullAndPush": ({ worktreeId }) =>
      syncAfter(worktreeId, (w) => {
        w.behind = 0;
        pushed(w);
      }),
    "worktrees:commitDiff": () => FAKE_DIFF,
    "worktrees:branchDiff": () => FAKE_DIFF,
    // The Git timeline's reads: the row's own commits, from a fork on
    // the primary branch for any worktree but the primary, one stash on
    // happy-hummingbird, nothing stopped, and a hunk per picked file.
    "worktrees:branchHistory": ({ worktreeId }) => {
      const w = findWorktree(worktreeId);
      return {
        commits: w?.recentCommits ?? [],
        more: false,
        base:
          w && !w.isPrimary
            ? { ref: w.primaryRef ?? "origin/main", hash: "a1b2c3d" }
            : null,
        upstream: w?.hasUpstream ? `origin/${w.branch}` : null,
        unpushed: (w?.recentCommits ?? [])
          .slice(0, w?.ahead ?? 0)
          .map((c) => c.hash),
        incoming: [],
        incomingMore: false,
        upstreamFork: null,
        merges: [],
      };
    },
    "worktrees:stashes": ({ worktreeId }) => fakeStashes[worktreeId] ?? [],
    "worktrees:stashDiff": () => FAKE_DIFF,
    "worktrees:operation": () => ({
      operation: null,
      continuable: false,
      conflicted: 0,
      rebasing: null,
    }),
    "worktrees:fileHunks": ({ worktreeId, path }) =>
      changes.hunks(worktreeId, path),
    // For an amend's prefill: the subject the row carries, no body.
    "worktrees:commitMessage": ({ worktreeId, hash }) => ({
      summary:
        findWorktree(worktreeId)?.recentCommits.find((c) => c.hash === hash)
          ?.subject ?? "",
      description: "",
    }),
    "worktreeData:read": ({ worktreeId }) =>
      worktreeData.get(worktreeId) ?? null,
    "worktreeData:write": ({ worktreeId, data }) => {
      worktreeData.set(worktreeId, {
        ...worktreeData.get(worktreeId),
        ports: data.ports,
      });
    },
    // The host's own merge, with the posed liveness mapped on.
    "ports:list": ({ worktreeId }) => ({
      ports: mergeWorktreePorts(
        fakePoolPorts[worktreeId] ?? [],
        worktreeData.get(worktreeId)?.ports ?? [],
      ).map((entry) =>
        Object.assign(entry, { listening: fakeListeningPorts.has(entry.port) }),
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
    // The switch ?notSharing poses, which this device's account page
    // flips.
    "sharing:read": () => !notSharing.has(forest.deviceId),
    "sharing:set": (on) => {
      if (on) notSharing.delete(forest.deviceId);
      else notSharing.add(forest.deviceId);
      emit("sharing:changed", on);
    },
    "globalConfig:read": () => fakeGlobalConfig,
    "globalConfig:writeDeviceSettings": () => undefined,
    // The devices ?updates poses (none by default) have an
    // update staged, so the restart-to-update buttons on their Settings
    // General sections have something to show, and the ones ?downloading poses
    // are fetching it. Installing stands in for the restart into the
    // new build: the device reports up to date. Updating one with
    // nothing staged shows the download first.
    "updater:get": () =>
      stagedUpdates.has(forest.deviceId)
        ? { kind: "ready", version: FAKE_UPDATE_VERSION, releaseDate: null }
        : downloadingUpdates.has(forest.deviceId)
          ? { kind: "downloading", version: FAKE_UPDATE_VERSION }
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
        version: FAKE_UPDATE_VERSION,
      });
      setTimeout(() => {
        downloadingUpdates.delete(forest.deviceId);
        emit("updater:state", { kind: "idle" });
      }, 2_500);
    },
    "launchers:detect": () => [...FAKE_DETECTED],
    "launchers:forProject": () => ({
      entries: [...FAKE_LAUNCHERS],
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
    "githubCli:readiness": () => {
      const gh = new URLSearchParams(location.search).get("gh");
      return {
        installed: gh !== "missing",
        authed: gh === null,
        unavailable:
          gh === null
            ? null
            : gh === "missing"
              ? "gh-missing"
              : "gh-signed-out",
      };
    },
    "githubCli:owners": () => ["rin", "sylophi", "dittofleet"],
    "githubCli:repos": () => [
      "sylophi/shigoto-no-mori",
      "dittofleet/terrier",
      "rin/dotfiles",
      "dittofleet/port-pool",
      "rin/notes",
    ],
    // Takes the push's moment, and gives the project the remote it
    // would have.
    "githubCli:publish": async ({ projectId, owner = "rin" }) => {
      await sleep(1500);
      const at = forest.projects.findIndex((entry) => entry.id === projectId);
      const project = forest.projects[at];
      if (!project) throw new Error("Unknown project");
      forest.projects[at] = {
        ...project,
        identity: `remote:github.com/${owner}/${project.name}`,
      };
    },
    "terrier:readiness": () => ({ installed: true, readable: true }),
    // One repo, one set of PRs: every checkout of shigoto-no-mori
    // answers with the same map, as the real sweep would on each
    // device, so a stack reads the same from every device's rows.
    "githubCli:projectPullRequests": ({ projectId }) =>
      fakePullRequests(projectId),
    "githubCli:worktreePullRequest": ({ branch }) =>
      fakePullRequestDetail(branch),
    "githubCli:repoMergeConfig": () => FAKE_REPO_MERGE_CONFIG,
    "githubCli:repoDescription": ({ projectId }) =>
      repoDescriptionFor(
        forest.projects.find((project) => project.id === projectId)?.name ?? "",
      ),
    // The merge button's outcome, and the PR reading as armed or
    // merged after it, so the flow can be walked in the fake host.
    "githubCli:mergePullRequest": ({ method }) => fakeMergePullRequest(method),
    "githubCli:disablePullRequestAutoMerge": () => fakeDisableAutoMerge(),
    "sync:worktreeFolder": ({ relative }) => [...(FAKE_TREE[relative] ?? [])],
    "sync:ignoredPaths": () => ({
      paths: [...FAKE_IGNORED_PATHS],
      total: FAKE_IGNORED_PATHS.length,
      patterns: [...FAKE_IGNORED_PATHS],
    }),
    // The mirror picture is host-scoped: the forest holding the
    // original reports the session it runs, and the copy's forest the
    // stream it serves. Both refresh off mirror:changed. Copies, since
    // the posed cycle mutates the session in place.
    "mirror:list": () => ({
      daemon: posedMirrorEngine(),
      sessions: fakeMirrors.sessions
        .filter((session) => fakeRunners.get(session) === forest.deviceId)
        .map((session) => structuredClone(session)),
      serving: fakeMirrors.serving
        .filter((stream) => stream.deviceId === forest.deviceId)
        .map(({ deviceId: _device, ...stream }) => stream),
    }),
    // The posed running scripts. A stop ends the run at once and says
    // so the way the host does, so the Live page's row goes.
    "scripts:list": () => ({
      runs: [...(fakeRunningScripts[forest.deviceId] ?? [])],
    }),
    // A console opened on a posed run replays a posed log, then the
    // run keeps printing a line every few seconds while it is listed.
    "scripts:attach": ({ runId }) => {
      const run = (fakeRunningScripts[forest.deviceId] ?? []).find(
        (entry) => entry.runId === runId,
      );
      if (run === undefined) return null;
      fakeScriptTicker(forest.deviceId, runId, emit);
      return { output: fakeScriptLog(run), streaming: false };
    },
    // A package script started (its button, the Live page's restart):
    // listed as running, with a log of its own.
    "packageScripts:run": ({ projectId, worktreeId, scriptName }) => {
      const runId = `run-${Date.now().toString(36)}`;
      const run = {
        runId,
        projectId,
        worktreeId,
        slot: { kind: "package" as const, name: scriptName },
        startedAt: Date.now(),
        interactive: true,
      };
      fakeRunningScripts[forest.deviceId] = [
        ...(fakeRunningScripts[forest.deviceId] ?? []),
        run,
      ];
      emit("scripts:changed", undefined);
      setTimeout(() => {
        emit("scripts:event", {
          runId,
          kind: "data",
          data: fakeScriptLog(run),
        });
        fakeScriptTicker(forest.deviceId, runId, emit);
      }, 300);
      return { runId };
    },
    "scripts:cancel": ({ runId }) => {
      const runs = fakeRunningScripts[forest.deviceId] ?? [];
      const cancelled = runs.some((run) => run.runId === runId);
      fakeRunningScripts[forest.deviceId] = runs.filter(
        (run) => run.runId !== runId,
      );
      if (cancelled) {
        emit("scripts:event", { runId, kind: "exit", code: null });
        emit("scripts:changed", undefined);
      }
      return { cancelled };
    },
    "mirror:history": ({ localWorktreeId }) => ({
      events: [...(fakeMirrors.history[localWorktreeId] ?? [])],
    }),
    // The controls of a session this forest runs (the manage dialog
    // re-scopes to the runner).
    "mirror:stop": ({ session }) => {
      const entry = findFakeSession(session);
      fakeMirrors.sessions = fakeMirrors.sessions.filter(
        (s) => s.session !== session,
      );
      fakeMirrors.serving = fakeMirrors.serving.filter(
        (stream) =>
          !(
            entry !== undefined &&
            stream.deviceId === entry.deviceId &&
            stream.worktreeId === entry.worktreeId
          ),
      );
      const copyForest = entry && forests[entry.deviceId];
      if (entry) noteMirrorEvent(entry.localWorktreeId, "stopped", "");
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
      ignores: readonly string[];
    }) => {
      const entry = findFakeSession(session);
      if (entry === undefined) throw new Error("[fake-host] no such mirror");
      entry.session = `sync_${fakeSessionSerial++}`;
      entry.ignoreMode = ignoreMode;
      entry.ignores = [...ignores];
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
          "mirror:startTo": (input) => fakeMirrorStartTo(forest, input),
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
          "sync:pullWorktree": (input) => fakeSyncPull(forest, emit, input),
          // "Mirror here" as the app runs it: the local start asks the
          // forest holding the original to run the mirror towards here.
          "mirror:startFrom": (input) => {
            const runner = forests[input.sourceDeviceId];
            if (runner === undefined) {
              throw new Error("[fake-host] no such device to mirror from");
            }
            return fakeMirrorStartTo(runner, {
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

// An install or uninstall, as the CLI answers it: a fresh Codex
// install isn't trusted yet.
function setHooks(
  harnesses: AgentHarnessStatus[],
  id: string,
  hooks: AgentHarnessStatus["hooks"],
): AgentHarnessStatus[] {
  return harnesses.map((harness) => {
    if (harness.id !== id) return harness;
    const { trusted: _trusted, ...rest } = harness;
    return hooks === "installed" && id === "codex"
      ? { ...rest, hooks, trusted: false }
      : { ...rest, hooks };
  });
}

// What a push or a publish leaves: every commit on the branch is on the
// remote now.
function pushed(worktree: FakeWorktree): void {
  worktree.ahead = 0;
  worktree.unpushedCount = 0;
}

// The posed moves under way, by source worktree, and whether each was
// asked to stop, so the dialogs' Cancel has something to cancel here.
const posedMoves = new Map<string, { cancelled: boolean }>();

// What git ignores on the posed worktree (FAKE_TREE's ignored entries,
// folders collapsed), serving as its gitignore rules too.
const FAKE_IGNORED_PATHS = [
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

// ---- running script fixtures ----

// What a posed run has printed so far: a dev server's start-up, or a
// setup's install.
function fakeScriptLog(run: RunningScript): string {
  const lines =
    run.slot.kind === "package"
      ? [
          `\x1b[2m$ pnpm ${run.slot.name}\x1b[0m`,
          "",
          "  \x1b[32m\x1b[1mVITE\x1b[0m v7.1.4  ready in \x1b[1m412\x1b[0m ms",
          "",
          "  \x1b[32m➜\x1b[0m  \x1b[1mLocal\x1b[0m:   \x1b[36mhttp://localhost:5731/\x1b[0m",
          "  \x1b[2m➜  Network: use --host to expose\x1b[0m",
          "",
        ]
      : [
          "\x1b[2m$ pnpm install\x1b[0m",
          "Lockfile is up to date, resolution step is skipped",
          "Progress: resolved 812, reused 790, downloaded 22, added 812",
        ];
  return lines.join("\r\n") + "\r\n";
}

// A line every few seconds from a posed run while it is listed, so an
// open console is seen following it.
const fakeTickers = new Set<string>();
function fakeScriptTicker(
  deviceId: string,
  runId: string,
  emit: FixtureWire["emit"],
) {
  if (fakeTickers.has(runId)) return;
  fakeTickers.add(runId);
  const timer = setInterval(() => {
    const live = (fakeRunningScripts[deviceId] ?? []).some(
      (run) => run.runId === runId,
    );
    if (!live) {
      clearInterval(timer);
      fakeTickers.delete(runId);
      return;
    }
    const time = new Date().toLocaleTimeString();
    emit("scripts:event", {
      runId,
      kind: "data",
      data: `\x1b[2m${time}\x1b[0m \x1b[36m[vite]\x1b[0m hmr update \x1b[2m/src/App.tsx\x1b[0m\r\n`,
    });
  }, 4_000);
}

// ---- mirror fixtures ----
//
// One mirror world for the whole fake host, since a session on Studio
// Mac and the stream Thinkpad serves for it are two views of the same
// fact. Each forest's emitter is remembered so mirror:changed reaches
// every page, a peer's riding the client wire's peer push
// (installFakeHostBridge).
// The posed sessions change in place as their fake engine cycles.
type FakeMirrorSession = Types.Mutable<MirrorSession>;
const fakeMirrors: {
  sessions: FakeMirrorSession[];
  serving: (MirrorServing & { deviceId: string })[];
  history: Record<string, MirrorEvent[]>;
} = { sessions: [], serving: [], history: {} };
// The forest running each session, the one holding the original.
const fakeRunners = new WeakMap<FakeMirrorSession, string>();
const mirrorWires = new Map<string, FixtureWire["emit"]>();
let pushFromPeer: (
  deviceId: string,
  channel: string,
  payload: unknown,
) => void = () => {};
let fakeSessionSerial = 1;

function mirrorChanged() {
  for (const emit of mirrorWires.values()) emit("mirror:changed", undefined);
}

function noteMirrorEvent(
  localWorktreeId: string,
  kind: MirrorEvent["kind"],
  detail: string,
) {
  const thread = fakeMirrors.history[localWorktreeId] ?? [];
  thread.unshift({ at: Date.now(), kind, detail });
  fakeMirrors.history[localWorktreeId] = thread.slice(0, MIRROR_HISTORY_LIMIT);
}

// ?mirrorEngine=running|starting|stopped|unavailable: every device's
// mirror engine, for the start buttons' disabled reasons. Running by
// default, so the start flows can be walked.
const MIRROR_ENGINE_STATES = [
  "running",
  "starting",
  "stopped",
  "unavailable",
] as const;
function posedMirrorEngine(): (typeof MIRROR_ENGINE_STATES)[number] {
  const posed = new URLSearchParams(location.search).get("mirrorEngine");
  return MIRROR_ENGINE_STATES.find((state) => state === posed) ?? "running";
}

function findFakeSession(session: string): FakeMirrorSession | undefined {
  return fakeMirrors.sessions.find((s) => s.session === session);
}

function setMirrorPaused(session: string, paused: boolean) {
  const entry = findFakeSession(session);
  if (entry === undefined) return;
  entry.paused = paused;
  entry.status = paused ? "disconnected" : "watching";
  entry.statusText = paused ? "Paused" : "Watching for changes";
  noteMirrorEvent(entry.localWorktreeId, paused ? "paused" : "resumed", "");
  mirrorChanged();
}

// A posed mirror, run by the forest holding the original: the send
// lands the copy on the local forest, then a session opens on top and
// settles. Afterwards a cycle runs every few seconds so the status is
// seen moving, and the thread gets a conflict once, for the history
// to have more than its start.
async function fakeMirrorStartTo(
  runner: DeviceForest,
  input: {
    targetDeviceId: string;
    projectId: string;
    worktreeId: string;
    runSetup?: boolean;
    ignoreMode: MirrorSession["ignoreMode"];
    ignores: readonly string[];
  },
) {
  const target = forests[input.targetDeviceId];
  const emit = mirrorWires.get(input.targetDeviceId);
  const project = runner.projects.find((entry) => entry.id === input.projectId);
  const sourceWorktree = (runner.worktrees[input.projectId] ?? []).find(
    (entry) => entry.id === input.worktreeId,
  );
  if (!target || !emit || !project?.identity || !sourceWorktree) {
    throw new Error("[fake-host] no such worktree to mirror");
  }
  // The rule is the session's, not the send's: a mirror start brings
  // the files through its own session, so the landing poses no files
  // step. A primary's copy lands on its mirror branch and folder.
  const landed = await fakeSyncPull(target, emit, {
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
  const session: FakeMirrorSession = {
    session: `sync_${fakeSessionSerial++}`,
    name: sourceWorktree.branch,
    labels: { mode: "mirror" },
    localRoot: sourceWorktree.path,
    localProjectId: input.projectId,
    localWorktreeId: input.worktreeId,
    deviceId: input.targetDeviceId,
    projectId: landed.worktree.projectId,
    worktreeId: landed.worktree.id,
    remoteRoot: landed.worktree.path,
    paused: false,
    ignores: [...input.ignores],
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
  fakeMirrors.sessions.push(session);
  fakeRunners.set(session, runner.deviceId);
  fakeMirrors.serving.push({
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
    const live = () => fakeMirrors.sessions.includes(session);
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

async function fakeSyncPull(
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
  if (project === undefined) throw new Error("[fake-host] no identity match");
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
    path: `/Users/rin/.sm/wt/${project.name}/${name}`,
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
    agentWorking: false,
    agentSessions: [],
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

// ---- account and presence state the fake host can change ----

// Whether Studio Mac accepts commands from the account's other devices
// (the account page switch on this device's row).
let acceptsCommands = true;
// Devices revoked in this fake host session: the fixture registry is static,
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

// The web-shell pose (web-main.tsx): this page is an enrolled
// BROWSER device, every machine forest (Studio Mac included) is a
// peer, and nothing is local. Passed into installFakeHostBridge rather than
// read from a global, since import hoisting evaluates this module
// before any entry-file code runs.
let WEB_SHELL = false;
const WEB_DEVICE_ID = "dev_beefcafe01";
// Village life on in this window's client config: ?villageLife=1, or
// the villager contact sheet's say. Off otherwise, as a fresh install
// has it. The villager data itself is villagerData.ts.
let villageLife = false;

// Presence the fake host can pose: which peers are in the roster, and which
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
// ?migration=waiting|moving|stuck|done: the v3 migration in that state
// (stepsFixtures.ts), for its page (?to=/migration). Without it there is
// nothing to migrate.
function posedMigration(): MigrationProgress {
  const pose = new URLSearchParams(location.search).get("migration");
  return pose !== null && pose in MIGRATION_POSES
    ? MIGRATION_POSES[pose as MigrationPose].migration
    : { planned: true, import: null, worktrees: null };
}

// ?notSharing=tp,mini: the devices with sharing off, which then serve
// this page nothing.
const notSharing = new Set<string>();
const FAKE_UPDATE_VERSION = "2.1.0";

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
  posedDevices(pose.get("updates") ?? "", stagedUpdates);
  posedDevices(pose.get("downloading") ?? "", downloadingUpdates);
  posedDevices(pose.get("notSharing") ?? "", notSharing);
  // ?hubBlocked=update-required: this device's hub socket blocked for
  // that reason, with the words the hub or the supervisor gives it.
  const blocked = pose.get("hubBlocked");
  if (blocked !== null && blocked in BLOCK_MESSAGES) {
    const reason = blocked as keyof typeof BLOCK_MESSAGES;
    socketPhase = {
      phase: "blocked",
      reason,
      message: BLOCK_MESSAGES[reason],
    };
  }
}

const BLOCK_MESSAGES = {
  "update-required":
    "This version of Shigoto no Mori is too old for the device hub. Update it to connect.",
  refused:
    "ticket mint failed: The device hub no longer accepts this device's credential.",
  revoked: "this device was removed from the account, sign in again",
  superseded: "another instance of this device took over the device hub",
};

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
const CROWD_OWNERS = ["sylophi", "rin", "kaiju-labs"];

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
      extra: (id: string) => FakeWorktree[] = () => [],
    ) => {
      forest.projects.push({
        id,
        name,
        path,
        pathExists: true,
        identity: shared ? `root:crowd${String(i).padStart(12, "0")}` : null,
        // A few owners to group by, and every seventh with no remote.
        remote:
          i % 7 === 6 ? null : `github.com/${CROWD_OWNERS[i % 3]}/${name}`,
        source: shared ? "terrier" : undefined,
        lastUsed: Date.now() - (i + 6) * 86_400_000,
        recentCount: 1,
      });
      forest.worktrees[id] = [
        worktreeFixture({
          id: worktreeIdOf(id),
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
            id: worktreeIdOf(`crowd ${i} ${n}`),
            projectId: id,
            name: animal,
            branch: n === 0 ? "fix-flaky-sync" : "exp/redo-cache",
            path: `/Users/rin/.sm/wt/${name}/${animal}`,
          }),
      ),
    );
    // Every fifth stays on this machine alone, so the projects differ.
    if (shared && i % 5 !== 4) {
      checkout(thinkpad, `tp_crowd_${i}`, `/home/rin/dev/${name}`);
    }
  });
}

// ?missing=1: a project on Studio Mac whose repo was moved by hand, so
// the sidebar lists it as missing. The repo sits under ~/dev now, for
// Locate… to find.
function initMissing(): void {
  const local = forests[LOCAL_DEVICE_ID];
  const disk = fakeDisks[LOCAL_DEVICE_ID];
  const pose = new URLSearchParams(location.search);
  if (pose.get("missing") !== "1" || local === undefined || !disk) return;
  disk.dirs["/Users/rin/dev"]?.push({ name: "tanuki-notes", isGitRepo: true });
  // Listed, so the folder picker can open it.
  disk.dirs["/Users/rin/dev/tanuki-notes"] = [];
  const path = "/Users/rin/projects/tanuki-notes";
  local.projects.push({
    id: "p_missing",
    name: "tanuki-notes",
    path,
    pathExists: false,
    identity: null,
    remote: null,
    lastUsed: Date.now() - 9 * 86_400_000,
    recentCount: 0,
  });
  local.worktrees["p_missing"] = [
    worktreeFixture({
      id: "d40000000001",
      projectId: "p_missing",
      name: "tanuki-notes",
      branch: "main",
      path,
      isPrimary: true,
    }),
  ];
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
  const peerSharesData: Record<string, boolean> = {};
  for (const id of directSessions) {
    peerAppVersions[id] = FAKE_APP_VERSION;
    peerAcceptsCommands[id] = forests[id]?.grantsCaller ?? false;
    peerSharesData[id] = !notSharing.has(id);
  }
  return {
    socket: socketPhase,
    onlineDeviceIds: [...roster],
    peerAppVersions,
    peerAcceptsCommands,
    peerSharesData,
    tunnel: "up",
  };
}

export function installFakeHostBridge(
  opts: {
    webShell?: boolean;
    villageLife?: boolean;
    // A dev build (the badge, the theme hotkeys), as the fake host is
    // unless it stands in for the released app (frames.tsx).
    dev?: boolean;
  } = {},
): ClientLinks["Service"] {
  WEB_SHELL = opts.webShell === true;
  villageLife =
    opts.villageLife ??
    new URLSearchParams(location.search).get("villageLife") === "1";
  initPresence();
  initCrowd();
  initMissing();
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
      // Heard on the peer's own wire (its views) and, the way the real
      // bridge delivers a peer's, as a peer push on the client wire.
      createFixtureWire("host", (emit) =>
        hostHandlersFor(forest, (channel, payload) => {
          emit(channel, payload);
          pushFromPeer(forest.deviceId, channel, payload);
        }),
      ),
    );
  }

  // The web shell has no local forest: its host wire serves nothing, so
  // every host read falls back to the schema stubs (empty lists),
  // matching the real browser bridge's shape.
  const localForest = forests[LOCAL_DEVICE_ID];
  if (localForest === undefined) throw new Error("[fake-host] no local forest");
  const localHost = createFixtureWire("host", (emit) =>
    WEB_SHELL
      ? // A browser still keeps its own copy of the shared settings.
        sharedSettingsHandlersFor(WEB_DEVICE_ID, emit)
      : hostHandlersFor(localForest, emit),
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
  // ?deviceKey=due|lapsed poses a device enrolled before device keys,
  // which reads signed out until it enrolls again: with its session live
  // (the enrollment goes by itself, a second and a half), or lapsed.
  let keyDue = ["due", "lapsed"].includes(
    new URLSearchParams(location.search).get("deviceKey") ?? "",
  );
  const accountStatus = () => ({
    configured: true,
    signedIn: !signedOut && !keyDue,
    accountId: signedOut ? "" : FAKE_ACCOUNT_ID,
    deviceName: WEB_SHELL ? "Chrome on MacBook" : deviceName,
    deviceIcon: deviceIcon ?? detectedIcon(),
    detectedDeviceIcon: detectedIcon(),
    sharedSignIn: false,
    needsDeviceKey: keyDue,
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
        worktree: { projectId: "tp_sm", worktreeId: "a1b2c3d4e5f6" },
      },
    ],
  ]);
  // ?liveEdge=1 (see addLiveEdgeRuns): a forward switched on from the
  // account page, so tied to no worktree, at another local port than
  // its own and with nothing connected.
  if (new URLSearchParams(location.search).get("liveEdge") === "1") {
    addLiveEdgeRuns();
    forwards.set("b7e0aa9c1d2f4e6081b3c5d7e9f1a2b4", {
      forwardId: "b7e0aa9c1d2f4e6081b3c5d7e9f1a2b4",
      deviceId: THINKPAD_ID,
      remotePort: 3000,
      localPort: 3001,
      connCount: 0,
    });
  }

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
    "migration:read": () => posedMigration(),
    "account:enroll": async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      keyDue = false;
      client.emit("account:changed", { accountId: accountStatus().accountId });
      return accountStatus();
    },
    "account:signOut": () => undefined,
    // ?view=inbox poses the sidebar layout over whatever the fake host session
    // has saved, so a shot can open on either view.
    "clientConfig:read": () => {
      const posedView = new URLSearchParams(location.search).get("view");
      let stored: Record<string, unknown> = {};
      try {
        stored = JSON.parse(
          localStorage.getItem("sm.fakeHost.clientConfig") ?? "{}",
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
      localStorage.setItem("sm.fakeHost.clientConfig", JSON.stringify(config));
    },
    "hub:status": hubSnapshot,
    "hub:invokePeer": ({ deviceId, channel, input }) => {
      const wire = peerWires.get(deviceId);
      if (wire === undefined) {
        return Promise.reject(
          new Error(`[fake-host] unknown peer ${deviceId}`),
        );
      }
      // The peer's SharingGate.
      if (notSharing.has(deviceId)) {
        return Promise.reject(new NotSharingError());
      }
      return wire.answer(channel, input).finally(wire.touch);
    },
    "shell:openExternal": ({ url }) => {
      window.open(url, "_blank", "noopener,noreferrer");
    },
    "shell:showItemInFolder": () => undefined,
    "releases:list": () => fakeReleases,
    "portForward:list": () => ({ forwards: [...forwards.values()] }),
    "portForward:start": async ({
      deviceId,
      remotePort,
      localPort,
      worktree,
    }) => {
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
      // start naming another local port moves it. Either way the
      // worktree asking claims it.
      let claimed = worktree;
      for (const [id, forward] of forwards) {
        if (
          forward.deviceId === deviceId &&
          forward.remotePort === remotePort
        ) {
          claimed ??= forward.worktree;
          if (forward.localPort === bound) {
            forwards.set(id, { ...forward, worktree: claimed });
            client.emit("portForward:changed", undefined);
            return { forwardId: id, localPort: bound };
          }
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
        worktree: claimed,
      });
      client.emit("portForward:changed", undefined);
      return { forwardId, localPort: bound };
    },
    "portForward:stop": ({ forwardId }) => {
      forwards.delete(forwardId);
      client.emit("portForward:changed", undefined);
    },
  };

  const client = createFixtureWire(
    "client",
    () => clientHandlers,
    (channel, input) => {
      if (channel !== "hub:watchPeer") return undefined;
      const hop = input as {
        deviceId: string;
        channel: string;
        input?: unknown;
      };
      const wire = peerWires.get(hop.deviceId);
      if (wire === undefined) {
        return Stream.fail(
          new Error(`[fake-host] unknown peer ${hop.deviceId}`),
        );
      }
      // The peer's SharingGate.
      if (notSharing.has(hop.deviceId))
        return Stream.fail(new NotSharingError());
      return wire.link.view(hop.channel, hop.input);
    },
  );
  pushFromPeer = (deviceId, channel, payload) =>
    client.emit("hub:peerPush", { deviceId, channel, payload });

  const fixtureClient = startClientNow(
    Layer.succeed(
      ClientLinks,
      ClientLinks.of({
        linkOf: (module) =>
          scopeOf(module) === "host" ? localHost.link : client.link,
      }),
    ),
  );
  disposeWithPage(fixtureClient);
  const api = {
    deviceId: selfDeviceId,
    appVersion: FAKE_APP_VERSION,
    clerkPublishableKey: "pk_test_fake",
    isDev: opts.dev ?? true,
    isElectron: !WEB_SHELL,
    ...fixtureClient.api,
  };
  // The renderer's window.d.ts types window.api, so this assignment is
  // the proof the fake host bridge has the same surface.
  window.api = api;

  const pushHub = () => client.emit("hub:statusChanged", hubSnapshot());

  window.fakeHost = {
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
      for (const session of fakeMirrors.sessions) {
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
    // "update" changes an existing row in place (by name), the way a
    // commit, push or checkout in a terminal would.
    worktree(
      deviceId,
      action,
      name,
      { projectId, changedCount, fields = {} } = {},
    ) {
      const forest = forests[deviceId];
      if (forest === undefined)
        throw new Error(`[fake-host] no device ${deviceId}`);
      const project =
        forest.projects.find((p) => p.id === projectId) ?? forest.projects[0];
      if (project === undefined) {
        throw new Error(
          `[fake-host] no project on ${deviceId} to put ${name} in`,
        );
      }
      const list = (forest.worktrees[project.id] ??= []);
      if (action === "add") {
        list.push(
          worktreeFixture({
            id: worktreeIdOf(`${project.id} ${name} ${Date.now()}`),
            projectId: project.id,
            name,
            branch: name,
            path: `${project.path}/../worktrees/${name}`,
            hasUpstream: false,
            changedCount: changedCount ?? 0,
            ...fields,
          }),
        );
      } else if (action === "update") {
        const row = list.find((w) => w.name === name);
        if (row === undefined) {
          throw new Error(`[fake-host] no worktree ${name} on ${deviceId}`);
        }
        Object.assign(row, fields);
        if (changedCount !== undefined) row.changedCount = changedCount;
      } else {
        forest.worktrees[project.id] = list.filter((w) => w.name !== name);
      }
      if (deviceId === selfDeviceId) {
        localHost.emit("git:externalChange", undefined);
      } else {
        mirrorWires.get(deviceId)?.("git:externalChange", undefined);
      }
    },
    emitClient: client.emit,
    emitHost: localHost.emit,
  };

  // ?mirrored=1: a mirror running from boot, Studio Mac's brave-badger
  // kept in step with a copy on Thinkpad, through the posed start.
  if (new URLSearchParams(location.search).get("mirrored") === "1") {
    void fakeMirrorStartTo(localForest, {
      targetDeviceId: THINKPAD_ID,
      projectId: "p_sm",
      worktreeId: "a10000000003",
      ignoreMode: "gitignored",
      ignores: [],
    });
  }

  return fixtureClient.links;
}
