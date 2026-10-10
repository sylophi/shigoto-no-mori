// The host's layer graph: what this machine serves, from the scripts it
// runs to the wires its peers, its windows and the terminal reach it
// on. It depends on nothing of the shell's (main/shellLayer.ts), which
// starts it. Each subsystem here is a lifetime: acquiring it starts the
// subsystem, and the scope closing stops it.
import { gitContract } from "@shigomori/contracts/modules/git";
import { scriptsContract } from "@shigomori/contracts/modules/scripts";
import { errorMessageOf } from "@shigomori/contracts/errors";
import { log, logFailure } from "@shared/log";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { readDeviceId } from "@host/lib/config/deviceId";
import { refreshProjects } from "@host/lib/projects";
import { loadSharedSettings } from "@host/lib/sharedSettings/store";
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
import * as Views from "@host/lib/views";
import * as Ports from "@host/lib/ports";
import * as ScriptRuns from "@host/lib/scripts/pty";
import * as Terminals from "@host/lib/terminals/Terminals";
import { terminalStart } from "@host/ipc/scriptRun";
import * as Terrier from "@host/lib/terrier";
import * as Villagers from "@host/lib/villagers";
import * as Processes from "@host/lib/util/processes";
import * as GitWatcher from "@host/lib/gitWatcher";
import { startBackgroundFetch } from "@host/lib/git/backgroundFetch";
import { repairCliLinks } from "@host/lib/cli/install";
import * as OrphanSweep from "@host/lib/scripts/persistence";
import * as FileSyncRunner from "@host/fileSync/runner";
import {
  announceProjectChanged,
  mirrorDaemonLayer,
  startGitFollower,
  startMirrorGateway,
  stopGitFollower,
  stopMirrorGateway,
} from "./handlers";
import { stopAllPortForwards } from "@host/ipc/modules/portForward";
import {
  broadcastAll,
  deviceLinkLayer,
  loopbackLayer,
  sharingLayer,
  stopDirectHost,
  stopHubConnection,
  tunnelLayer,
} from "./wires";
import { lifetime, onQuit, starts } from "@host/lib/util/lifetimes";
import * as Captures from "./captures";
import { deleteAdapter } from "@host/ipc/modules/worktrees";

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
      if (hurried()) return signalAllScriptsBestEffort;
      return Effect.forEach(getInflightDeleteIds(), killScriptsForWorktree, {
        concurrency: "unbounded",
        discard: true,
      }).pipe(Effect.andThen(killAllScripts({ graceMs: 1_500 })));
    }),
  );

// The sweeps and watchers read the project list synchronously, from the
// snapshot host/lib/projects keeps of the CLI's list.
const firstProjectList = Layer.effectDiscard(
  Effect.promise(() =>
    logFailure("[projects] first list failed", refreshProjects),
  ),
);

// The handlers read this device's copy of the shared settings
// synchronously.
const firstSharedSettings = Layer.effectDiscard(
  Effect.promise(() =>
    logFailure("[sharedSettings] first read failed", loadSharedSettings),
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
    Captures.mirrorDaemon
      .sessions()
      .map((session) => session.labels[MIRROR_LABEL_LOCAL_PROJECT])
      .filter((projectId) => projectId !== undefined),
  );
  for (const projectId of mirrored) announceProjectChanged(projectId);
  // The CLI may have added or removed a project: re-read the list,
  // then follow it with the git-directory watches.
  void refreshProjects()
    .catch(() => undefined)
    .then(Captures.reconcileGitWatchers);
  // A worktree or project gone takes its terminals with it.
  void Captures.closeMissingTerminals();
  // The app's only chance to notice an `sm rm` run in a terminal, which
  // leaves a script the app started there running in a deleted cwd and
  // holding its port.
  void Captures.scripts
    .run(reapScriptsForRemovedWorktrees())
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
  Captures.storeChanges.layer.pipe(
    Layer.provide(StoreChanges.layer(onExternalStateChange)),
  ),
);

// Git state inside every project (commits, checkouts, refs written by
// any tool), as a project-scoped ping on every wire.
const gitWatcher = logged(
  "the git watcher",
  Captures.gitWatcher.layer.pipe(
    Layer.provide(
      GitWatcher.layer({
        onChange: announceProjectChanged,
      }),
    ),
  ),
);

// The hub socket and the device link's listener, which follows the
// same enrollment condition. Both come up on the account's first report
// from the shell and reconcile on every one after (handlers.ts
// applyAccount). The closes are fire and forget: the hub close frame
// flushes or the Durable Object notices the dead socket, and the
// outbound links close. The listener closes with its own layer, below.
const remotePlanes = onQuit(
  "the hub connection",
  Effect.sync(() => {
    void stopHubConnection();
    stopDirectHost();
  }),
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
const mirrorDaemon = Captures.daemon.layer.pipe(
  Layer.provideMerge(mirrorDaemonLayer),
);
const mirrorGateway = lifetime(
  "the mirror gateway",
  Effect.promise(startMirrorGateway),
  stopMirrorGateway,
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
const toolAnswers = Captures.github.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(GithubCli.layer, Terrier.layer, Ports.layer),
  ),
);

// The bottom of the graph, closed last.
const foundation = (engine: Parameters<typeof Engine.layer>[0]) =>
  toolAnswers.pipe(
    // A villager download under way stops here, and resumes next launch.
    Layer.provideMerge(Villagers.deviceLayer),
    // Every push the host makes and every store write, which the wires
    // and the views read, and the views' shared reads.
    Layer.provideMerge(Captures.pushes.layer),
    Layer.provideMerge(Views.layer),
    Layer.provideMerge(HostPushes.layer),
    Layer.provideMerge(EngineStoreChanges.layer),
    // This device's id, which the wires above name themselves by, read
    // from the store once.
    Layer.provideMerge(Layer.effectDiscard(Effect.promise(readDeviceId))),
    // The engine and its store, which everything above reads and
    // writes the projects, worktrees and settings through.
    Layer.provideMerge(Engine.adapter),
    Layer.provideMerge(Engine.layer(engine)),
    // The Promise face of the platform's child processes for the code
    // that is not Effect yet. Last to go, so every finalizer above can
    // still spawn.
    Layer.provideMerge(Processes.adapter),
  );

// The lower half of the graph below: the file-sync children, the
// scripts and the foundation, closed last.
const scriptsAndFoundation = (options: {
  readonly hurried: () => boolean;
  readonly engine: Parameters<typeof Engine.layer>[0];
}) =>
  // Every file-sync child, the daemon and the serve children a peer's
  // streams opened.
  FileSyncRunner.layer.pipe(
    Layer.provideMerge(scripts(options.hurried)),
    // A crash, a force quit or an OOM skips the quit's reap, so what the
    // last run left running is reaped here. It claims the record file
    // synchronously, before any script can spawn, and kills in the
    // background.
    Layer.provideMerge(OrphanSweep.layer),
    // Every terminal, each saved for the next start as it closes with
    // the quit.
    Layer.provideMerge(Captures.terminals.layer),
    Layer.provideMerge(Terminals.layer({ start: terminalStart })),
    // Every script run, each in a scope the quit's policy above has
    // already closed or shortened.
    Layer.provideMerge(Captures.scripts.layer),
    Layer.provideMerge(ScriptRuns.layer),
    Layer.provideMerge(foundation(options.engine)),
  );

// Built from the bottom up, so the scope closes from the top down: read
// downward, this is the quit sequence.
export const layer = (options: {
  readonly hurried: () => boolean;
  readonly engine: Parameters<typeof Engine.layer>[0];
}) =>
  scriptGate.pipe(
    // The worktree deletes' Promise face, for the sync teardown.
    Layer.provideMerge(deleteAdapter),
    Layer.provideMerge(portForwards),
    // The loopback the terminal reaches the app on. It unpublishes its
    // address first as it stops, so a terminal run during the quit
    // reads "not running" instead of dialing a closing listener.
    Layer.provideMerge(loopbackLayer()),
    Layer.provideMerge(mirrorFollower),
    Layer.provideMerge(mirrorDaemon),
    Layer.provideMerge(mirrorGateway),
    Layer.provideMerge(remotePlanes),
    // The cloudflared child, fronting the device link's listener.
    Layer.provideMerge(tunnelLayer()),
    // The listener peers dial, which connected peers see go away
    // cleanly.
    Layer.provideMerge(deviceLinkLayer()),
    // The switch the listener's gate reads.
    Layer.provideMerge(sharingLayer),
    Layer.provideMerge(gitWatcher),
    Layer.provideMerge(storeChanges),
    Layer.provideMerge(
      starts("the background fetch", () =>
        startBackgroundFetch({
          refreshPullRequests: Captures.refreshPullRequests,
        }),
      ),
    ),
    // Installing the CLI link is a Settings action. A start only
    // repairs an installed link whose target moved (an app update,
    // another checkout).
    Layer.provideMerge(
      starts("the CLI link repair", () => void repairCliLinks()),
    ),
    Layer.provideMerge(firstProjectList),
    Layer.provideMerge(firstSharedSettings),
    Layer.provideMerge(scriptsAndFoundation(options)),
  );
