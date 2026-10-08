// The host's layer graph: what this machine serves, from the scripts it
// runs to the wires its peers and the terminal reach it on. Step 4 of
// V3.md moves it into a process of its own, so it depends on nothing in
// the shell's graph (shellLayer.ts). Its subsystems are wired in
// main/ipc and host/ today, and each one here is a lifetime: acquiring
// it starts the subsystem, and the scope closing stops it.
import { gitContract } from "@shigomori/contracts/modules/git";
import { scriptsContract } from "@shigomori/contracts/modules/scripts";
import { errorMessageOf, logFailure } from "@shigomori/contracts/errors";
import * as NodeServices from "@effect/platform-node/NodeServices";
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
import * as Processes from "@host/lib/util/processes";
import { gitSelfWroteWithin, SELF_ECHO_MS } from "@host/lib/util/selfWrite";
import {
  gitDirOf,
  reconcileGitWatchers,
  startGitWatcher,
  stopGitWatcher,
} from "./core/gitWatcher";
import { cliChildCount, killAllCli } from "./electron/cliRunner";
import { startBackgroundFetch } from "./electron/fetch";
import { startStateWatcher, stopStateWatcher } from "./electron/stateWatcher";
import {
  announceProjectChanged,
  startMirrorEngine,
  stopMirrorEngine,
} from "./ipc/handlers";
import { stopAllPortForwards } from "./ipc/modules/portForward";
import {
  broadcastAll,
  onHostMutationSettled,
  refreshHubConnection,
  startControlHost,
  stopControlHost,
  stopDirectHost,
  stopHubConnection,
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
    Effect.suspend(() => {
      if (hurried()) {
        return Effect.sync(() => signalAllScriptsBestEffort("SIGTERM"));
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

// The CLI's children run in their own process groups, and a lifecycle
// script one spawned follows it down. The file-sync processes register
// here too, so a mirror daemon still up after its stop goes with them.
const cliChildren = onQuit(Effect.sync(killAllCli));

// The sweeps and watchers read the project list synchronously, from the
// snapshot host/lib/projects keeps of the CLI's list.
const firstProjectList = Layer.effectDiscard(
  Effect.promise(() =>
    logFailure("[projects] first list failed", refreshProjects),
  ),
);

// External CLI writes reach the windows as an explicit invalidation
// broadcast. Window focus will not do: React Query refetches only on a
// blur to focus transition, and the window may be focused the whole
// time an agent works in a terminal beside it.
function onExternalStateChange(worktreeDataProjects: ReadonlySet<string>) {
  broadcastAll(gitContract, "externalChange", undefined);
  // A title `sm describe` wrote, announced like a git change so a
  // mirror of the worktree carries it now (host/mirror/gitFollow.ts).
  for (const projectId of worktreeDataProjects) {
    announceProjectChanged(projectId);
  }
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
      console.warn(
        `[scripts] reap after external change failed: ${errorMessageOf(error)}`,
      );
    });
}

const stateWatcher = lifetime(
  "the state watcher",
  Effect.sync(() => startStateWatcher(onExternalStateChange)),
  stopStateWatcher,
);

// Git state inside every project (commits, checkouts, refs written by
// any tool), as a project-scoped ping on every wire.
const gitWatcher = lifetime(
  "the git watcher",
  Effect.sync(() => {
    startGitWatcher({
      onChange: announceProjectChanged,
      // The app's own git commands move refs the same way an agent's
      // do, and their callers already invalidate their targets, so a
      // running sm child and an app-run mutating git command in flight
      // or just done in that repository are skipped, as the state
      // watcher skips the app's own data dir writes.
      suppressed: (gitDir) =>
        cliChildCount() > 0 ||
        gitSelfWroteWithin(SELF_ECHO_MS, (cwd) => gitDirOf(cwd) === gitDir),
    });
    // An app-side project add or remove runs as a CLI child whose
    // registry write the state watcher drops as the app's own.
    onHostMutationSettled(reconcileGitWatchers);
  }),
  stopGitWatcher,
);

// The hub socket and the direct listener, which follows the same
// enrollment condition. Both reconcile again on every account change
// (main/ipc/handlers.ts). The closes are fire and forget: the hub close
// frame flushes or the Durable Object notices the dead socket, and
// connected peers see the direct listener go away cleanly.
const remotePlanes = lifetime(
  "the hub connection",
  Effect.sync(() => void refreshHubConnection()),
  () => {
    void stopHubConnection();
    void stopDirectHost();
  },
);

// The mirror daemon resumes persisted sessions the moment it is up, so
// it starts with the app. After app ready: the sessions it resumes are
// swept for a device on no account, which reads the credential, and
// safeStorage cannot decrypt it before ready.
const mirrorEngine = lifetime(
  "the mirror engine",
  Effect.promise(() =>
    logFailure("[mirror] engine failed to start", startMirrorEngine),
  ),
  stopMirrorEngine,
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
const scriptGate = onQuit(Effect.sync(markShuttingDown));

// Port forwards start on demand. Stopping them before the remote planes
// gives their best-effort closes a socket to ride out on.
const portForwards = onQuit(Effect.sync(stopAllPortForwards));

// Built from the bottom up, so the scope closes from the top down: read
// downward, this is the quit sequence.
export const layer = (options: { readonly hurried: () => boolean }) =>
  scriptGate.pipe(
    Layer.provideMerge(portForwards),
    Layer.provideMerge(controlHost),
    Layer.provideMerge(mirrorEngine),
    Layer.provideMerge(remotePlanes),
    Layer.provideMerge(gitWatcher),
    Layer.provideMerge(stateWatcher),
    Layer.provideMerge(starts("the background fetch", startBackgroundFetch)),
    Layer.provideMerge(firstProjectList),
    Layer.provideMerge(cliChildren),
    Layer.provideMerge(scripts(options.hurried)),
    // The platform's services, and the Promise face of its child
    // processes for the code that is not Effect yet. Last to go, so
    // every finalizer above can still spawn.
    Layer.provideMerge(Processes.adapter),
    Layer.provideMerge(NodeServices.layer),
  );
