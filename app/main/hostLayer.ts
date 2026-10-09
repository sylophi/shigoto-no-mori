// The host's layer graph: what this machine serves, from the scripts it
// runs to the wires its peers and the terminal reach it on. Step 4 of
// V3.md moves it into a process of its own, so it depends on nothing in
// the shell's graph (shellLayer.ts). Its subsystems are wired in
// main/ipc and host/ today, and each one here is a lifetime: acquiring
// it starts the subsystem, and the scope closing stops it.
import { gitContract } from "@shigomori/contracts/modules/git";
import { scriptsContract } from "@shigomori/contracts/modules/scripts";
import { errorMessageOf } from "@shigomori/contracts/errors";
import { log, logFailure } from "@shared/log";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { refreshProjects } from "@host/lib/projects";
import {
  getInflightDeleteIds,
  killAllScripts,
  killScriptsForWorktree,
  markShuttingDown,
  signalAllScriptsBestEffort,
} from "@host/lib/scripts";
import { reapScriptsForRemovedWorktrees } from "@host/lib/scripts/removedWorktrees";
import * as Engine from "@host/lib/engine";
import * as StoreChanges from "@host/lib/storeChanges";
import * as EngineStoreChanges from "@shigomori/engine/StoreChanges";
import { MIRROR_LABEL_LOCAL_PROJECT } from "@host/mirror/registry";
import * as GithubCli from "@host/lib/githubCli/GithubCli";
import * as HostPushes from "@host/lib/hostPushes";
import * as Ports from "@host/lib/ports";
import * as ScriptRuns from "@host/lib/scripts/pty";
import * as Terrier from "@host/lib/terrier";
import * as Villagers from "@host/lib/villagers";
import * as Processes from "@host/lib/util/processes";
import * as GitWatcher from "./core/gitWatcher";
import { reconcileGitWatchers } from "./core/gitWatcher";
import { startBackgroundFetch } from "./electron/fetch";
import * as MirrorDaemon from "./core/mirror/daemon";
import * as FileSyncRunner from "./electron/fileSyncRunner";
import {
  announceProjectChanged,
  mirrorDaemonLayer,
  startGitFollower,
  startMirrorGateway,
  stopGitFollower,
  stopMirrorGateway,
} from "./ipc/handlers";
import { stopAllPortForwards } from "./ipc/modules/portForward";
import {
  broadcastAll,
  deviceLinkLayer,
  refreshHubConnection,
  startControlHost,
  stopControlHost,
  stopDirectHost,
  stopHubConnection,
  tunnelLayer,
} from "./ipc/register";
import { lifetime, onQuit, starts } from "./lifetimes";

// What the user started through a script must not outlive the app,
// orphaned to launchd. A delete in flight loses its cleanup scripts
// first, which leaves the worktree directory whole. A hurried quit
// signals and moves on: an update's installer is waiting on this
// process to exit, and the data-folder move behind a relaunch has
// already reaped. A script that ignores the signal may outlive it,
// which an explicit update accepts.
const scripts = (hurried: () => boolean) =>
  onQuit(
    "the scripts",
    Effect.suspend(() => {
      if (hurried()) {
        return Effect.sync(() => signalAllScriptsBestEffort());
      }
      return Effect.forEach(
        getInflightDeleteIds(),
        (worktreeId) =>
          Effect.tryPromise(() => killScriptsForWorktree(worktreeId)).pipe(
            Effect.ignore,
          ),
        { concurrency: "unbounded", discard: true },
      ).pipe(
        Effect.andThen(
          Effect.promise(() => killAllScripts({ graceMs: 1_500 })),
        ),
      );
    }),
  );

// The sweeps and watchers read the project list synchronously, from the
// snapshot host/lib/projects keeps of the CLI's list.
const firstProjectList = Layer.effectDiscard(
  Effect.promise(() =>
    logFailure("[projects] first list failed", refreshProjects),
  ),
);

// A store write, the terminal's or the app's own, reaches every window
// and every viewing device as an explicit invalidation broadcast.
// Window focus will not do: React Query refetches only on a blur to
// focus transition, and the window may be focused the whole time an
// agent works in a terminal beside it.
function onExternalStateChange() {
  broadcastAll(gitContract, "externalChange", undefined);
  // A title `sm describe` wrote, announced like a git change so a
  // mirror of the worktree carries it now (host/mirror/gitFollow.ts).
  // Which worktree it was is not told, so every mirrored project is.
  const mirrored = new Set(
    MirrorDaemon.mirrorDaemon
      .sessions()
      .map((session) => session.labels[MIRROR_LABEL_LOCAL_PROJECT])
      .filter((projectId) => projectId !== undefined),
  );
  for (const projectId of mirrored) announceProjectChanged(projectId);
  // The CLI may have added or removed a project: re-read the list,
  // then follow it with the git-directory watches.
  void refreshProjects()
    .catch(() => undefined)
    .then(reconcileGitWatchers);
  // The app's only chance to notice an `sm rm` run in a terminal, which
  // leaves a script the app started there running in a deleted cwd and
  // holding its port.
  void reapScriptsForRemovedWorktrees()
    .then((removed) => {
      for (const worktree of removed) {
        broadcastAll(scriptsContract, "stoppedForRemovedWorktree", {
          worktreeId: worktree.worktreeId,
          worktreeName: worktree.worktreeName,
          scriptCount: worktree.scriptCount,
        });
      }
    })
    .catch((error: unknown) => {
      log.warn(
        `[scripts] reap after external change failed: ${errorMessageOf(error)}`,
      );
    });
}

// A layer that failed to start is logged and the rest of the graph
// still comes up, like a lifetime (lifetimes.ts).
const logged = <R>(name: string, layer: Layer.Layer<never, never, R>) =>
  layer.pipe(
    Layer.catchCause((cause) =>
      Layer.effectDiscard(
        Effect.logError(`[boot] ${name} failed to start:`, Cause.squash(cause)),
      ),
    ),
  );

const storeChanges = logged(
  "the store's changes",
  StoreChanges.adapter.pipe(
    Layer.provide(StoreChanges.layer(onExternalStateChange)),
  ),
);

// Git state inside every project (commits, checkouts, refs written by
// any tool), as a project-scoped ping on every wire.
const gitWatcher = logged(
  "the git watcher",
  GitWatcher.adapter.pipe(
    Layer.provide(
      GitWatcher.layer({
        onChange: announceProjectChanged,
      }),
    ),
  ),
);

// The hub socket and the device link's listener, which follows the
// same enrollment condition. Both reconcile again on every account
// change (main/ipc/handlers.ts). The closes are fire and forget: the
// hub close frame flushes or the Durable Object notices the dead
// socket, and the outbound links close. The listener closes with its
// own layer, below.
const remotePlanes = lifetime(
  "the hub connection",
  Effect.sync(() => void refreshHubConnection()),
  () => {
    void stopHubConnection();
    stopDirectHost();
  },
);

// The mirror engine: the git follower, the daemon, and the gateway the
// daemon dials peers through. The daemon resumes persisted sessions the
// moment it is up, so it starts with the app. After app ready: the sessions it
// resumes are swept for a device on no account, which reads the
// credential, and safeStorage cannot decrypt it before ready.
const mirrorFollower = lifetime(
  "the mirror follower",
  Effect.sync(startGitFollower),
  stopGitFollower,
);
const mirrorDaemon = MirrorDaemon.adapter.pipe(
  Layer.provideMerge(mirrorDaemonLayer),
);
const mirrorGateway = lifetime(
  "the mirror gateway",
  Effect.promise(startMirrorGateway),
  stopMirrorGateway,
);

// The control wire the CLI's cross-device verbs ride. Stopping it
// unpublishes the address first, so a CLI run during the quit reads
// "not running" instead of dialing a closing listener.
const controlHost = lifetime(
  "the control host",
  Effect.promise(startControlHost),
  stopControlHost,
);

// New scripts are refused from the moment the quit begins, so none
// starts after the reap at the end has looked.
const scriptGate = onQuit("the script gate", Effect.sync(markShuttingDown));

// Port forwards start on demand. Stopping them before the remote planes
// gives their best-effort closes a socket to ride out on.
const portForwards = onQuit(
  "the port forwards",
  Effect.sync(stopAllPortForwards),
);

// What the host answers from caches of other tools: gh, terrier and
// port-pool.
const toolAnswers = Layer.mergeAll(
  GithubCli.adapter,
  Terrier.adapter,
  Ports.adapter,
).pipe(
  Layer.provideMerge(
    Layer.mergeAll(GithubCli.layer, Terrier.layer, Ports.layer),
  ),
);

// The bottom of the graph, closed last.
const foundation = (engine: Parameters<typeof Engine.layer>[0]) =>
  toolAnswers.pipe(
    // A villager download under way stops here, and resumes next launch.
    Layer.provideMerge(Villagers.adapter),
    Layer.provideMerge(Villagers.deviceLayer),
    // Every push the host makes and every store write, which the wires
    // and the views read.
    Layer.provideMerge(HostPushes.adapter),
    Layer.provideMerge(HostPushes.layer),
    Layer.provideMerge(EngineStoreChanges.layer),
    // The engine and its store, which everything above reads and
    // writes the projects, worktrees and settings through.
    Layer.provideMerge(Engine.adapter),
    Layer.provideMerge(Engine.layer(engine)),
    // The Promise face of the platform's child processes for the code
    // that is not Effect yet. Last to go, so every finalizer above can
    // still spawn.
    Layer.provideMerge(Processes.adapter),
  );

// Built from the bottom up, so the scope closes from the top down: read
// downward, this is the quit sequence.
export const layer = (options: {
  readonly hurried: () => boolean;
  readonly engine: Parameters<typeof Engine.layer>[0];
}) =>
  scriptGate.pipe(
    Layer.provideMerge(portForwards),
    Layer.provideMerge(controlHost),
    Layer.provideMerge(mirrorFollower),
    Layer.provideMerge(mirrorDaemon),
    Layer.provideMerge(mirrorGateway),
    Layer.provideMerge(remotePlanes),
    // The cloudflared child, fronting the device link's listener.
    Layer.provideMerge(tunnelLayer),
    // The listener peers dial, which connected peers see go away
    // cleanly.
    Layer.provideMerge(deviceLinkLayer),
    Layer.provideMerge(gitWatcher),
    Layer.provideMerge(storeChanges),
    Layer.provideMerge(starts("the background fetch", startBackgroundFetch)),
    Layer.provideMerge(firstProjectList),
    // Every file-sync child, the daemon and the serve children a peer's
    // streams opened.
    Layer.provideMerge(FileSyncRunner.layer),
    Layer.provideMerge(scripts(options.hurried)),
    // Every script run, each in a scope the quit's policy above has
    // already closed or shortened.
    Layer.provideMerge(ScriptRuns.adapter),
    Layer.provideMerge(ScriptRuns.layer),
    Layer.provideMerge(foundation(options.engine)),
  );
