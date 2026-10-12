// The host's layer graph: what this machine serves, from the scripts it
// runs to the wires its peers, its windows and the terminal reach it
// on. It depends on nothing of the shell's (main/shellLayer.ts), which
// starts it. Each subsystem here is a lifetime: acquiring it starts the
// subsystem, and the scope closing stops it.
import { gitContract } from "@shigomori/contracts/modules/git";
import { scriptsContract } from "@shigomori/contracts/modules/scripts";
import { worktreesContract } from "@shigomori/contracts/modules/worktrees";
import { errorWordsOf } from "@host/lib/errorWords";
import { log } from "@shared/log";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import * as DeviceId from "@host/lib/config/DeviceId";
import * as HostAccount from "@host/lib/HostAccount";
import { DataDirHolders } from "@host/lib/DataDirHolders";
import * as Shell from "@host/lib/Shell";
import * as Loopback from "@host/socket/loopback";
import { refresh } from "@host/lib/projects";
import * as SharedSettingsStore from "@host/lib/sharedSettings/store";
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
import * as Views from "@host/lib/views";
import * as Ports from "@host/lib/Ports";
import * as ScriptRuns from "@host/lib/scripts/pty";
import * as ScriptChanges from "@host/lib/scripts/ScriptChanges";
import * as Terminals from "@host/lib/terminals/Terminals";
import { terminalStart } from "@host/ipc/scriptRun";
import * as Terrier from "@host/lib/terrier";
import * as Villagers from "@host/lib/VillagerData";
import * as Worktrees from "@host/lib/Worktrees";
import * as GitWatcher from "@host/lib/GitWatcher";
import * as BackgroundFetch from "@host/lib/BackgroundFetch";
import { repairCliLinks } from "@host/lib/cli/install";
import * as OrphanSweep from "@host/lib/scripts/OrphanSweep";
import * as Moves from "@host/lib/sync/Moves";
import * as FileSyncRunner from "@host/fileSync/runner";
import {
  announceProjectChanged,
  mirrorChangesLayer,
  mirrorDaemonLayer,
  mirrorLayer,
  mirrorSessionsNow,
  portForwardsLayer,
  rootServices,
  scriptsChangedLayer,
  startMirrorGateway,
  stopMirrorGateway,
} from "./handlers";
import {
  broadcastAll,
  deviceLinkLayer,
  loopbackLayer,
  pushesLayer,
  remotePlanesLayer,
  sharingLayer,
  tunnelLayer,
} from "./wires";
import { lifetime, onQuit, starts } from "@shared/lifetimes";
import * as Migration from "@shigomori/engine/Migration";
import { hostFacts } from "./facts";
import * as Graph from "./graph";
import * as MigrationShell from "./migration";

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
// snapshot host/lib/projects keeps of the engine's list.
const firstProjectList = Layer.effectDiscard(
  refresh.pipe(
    Effect.catch((error) =>
      Effect.sync(() => log.warn("[projects] first list failed:", error)),
    ),
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
    mirrorSessionsNow()
      .map((session) => session.labels[MIRROR_LABEL_LOCAL_PROJECT])
      .filter((projectId) => projectId !== undefined),
  );
  for (const projectId of mirrored) announceProjectChanged(projectId);
  // The terminal may have added or removed a project: re-read the list,
  // then follow it with the git-directory watches.
  // A watcher that failed to start has nothing to follow.
  void Graph.run(
    refresh.pipe(
      Effect.ignore,
      Effect.andThen(Effect.serviceOption(GitWatcher.GitWatcher)),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.void,
          onSome: (watcher) => watcher.reconcile,
        }),
      ),
    ),
  ).catch(() => {});
  // A worktree or project gone takes its terminals with it.
  void Graph.runIfUp(
    Effect.flatMap(Terminals.Terminals, (terminals) => terminals.closeMissing),
  );
  // The app's only chance to notice an `sm rm` run in a terminal, which
  // leaves a script the app started there running in a deleted cwd and
  // holding its port.
  void Graph.run(reapScriptsForRemovedWorktrees())
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
        `[scripts] reap after external change failed: ${errorWordsOf(error)}`,
      );
    });
}

// A layer that failed to start is logged and the rest of the graph
// still comes up, like a lifetime (lifetimes.ts).
// What it would have provided is then absent (Effect.serviceOption).
const logged = <A, R>(
  name: string,
  layer: Layer.Layer<A, never, R>,
): Layer.Layer<never, never, R> =>
  layer.pipe(
    Layer.catchCause((cause) =>
      Layer.effectDiscard(
        Effect.logError(`[boot] ${name} failed to start:`, Cause.squash(cause)),
      ),
    ),
  );

const storeChanges = logged(
  "the store's changes",
  StoreChanges.layer(onExternalStateChange),
);

// Git state inside every project (commits, checkouts, refs written by
// any tool), as a project-scoped ping on every wire.
const gitWatcher = logged(
  "the git watcher",
  GitWatcher.layer({
    onChange: announceProjectChanged,
    onFilesChanged: (projectId) =>
      broadcastAll(worktreesContract, "filesChanged", { projectId }),
  }),
);

// The hub socket and the direct plane, and the device link's listener,
// which follows the same enrollment condition. Both connect on the
// account's first report from the shell and reconcile on every one
// after (handlers.ts applyAccount). The listener closes with its own
// layer, below.
const remotePlanes = logged("the device hub", remotePlanesLayer);

// The mirror engine: the git follower, the daemon, and the gateway the
// daemon dials peers through. The daemon resumes persisted sessions the
// moment it is up, so it starts with the app. The sessions it resumes
// are swept for a device on no account once the shell's first account
// report lands (handlers.ts noAccountSweep).
const mirrorFollower = logged("the mirror follower", mirrorLayer);
const mirrorDaemon = mirrorDaemonLayer;
const mirrorGateway = lifetime(
  "the mirror gateway",
  Effect.promise(startMirrorGateway),
  stopMirrorGateway,
);

// New scripts are refused from the moment the quit begins, so none
// starts after the reap at the end has looked.
const scriptGate = onQuit("the script gate", Effect.sync(markShuttingDown));

// What lets go of the data folder before a move takes it away: the
// store, the updater's bridge and the loopback's address file.
const dataDirHolders = Layer.effect(
  DataDirHolders,
  Effect.gen(function* () {
    const store = yield* EngineStoreChanges.StoreChanges;
    const shell = yield* Shell.Shell;
    const loopback = yield* Loopback.Loopback;
    return DataDirHolders.of({
      release: store.release.pipe(
        Effect.andThen(shell.stopUpdaterBridge),
        Effect.andThen(loopback.unpublish),
      ),
    });
  }),
);

// What the host answers from caches: other tools' (gh, terrier and
// port-pool), and its reads across a project's checkouts.
const cachedAnswers = Layer.mergeAll(
  GithubCli.layer,
  Terrier.layer,
  Ports.layer,
  Worktrees.layer,
);

// The bottom of the graph, closed last.
const foundation = (engine: Parameters<typeof Engine.layer>[0]) =>
  cachedAnswers.pipe(
    // A villager download under way stops here, and resumes next launch.
    Layer.provideMerge(Villagers.deviceLayer),
    // Every push the host makes and every store write, which the wires
    // and the views read, and the views' shared reads.
    Layer.provideMerge(Views.layer),
    Layer.provideMerge(pushesLayer),
    Layer.provideMerge(EngineStoreChanges.layer),
    // What the root provides from its own wiring: the peers' reach,
    // the mirror engine and the account.
    Layer.provideMerge(rootServices),
    // This device's id, which the wires above name themselves by, read
    // from the store once.
    Layer.provideMerge(DeviceId.layer),
    // The account as the shell last reported it, which the wires above
    // follow.
    Layer.provideMerge(HostAccount.layer),
    // The engine and its store, which everything above reads and
    // writes the projects, worktrees and settings through.
    Layer.provideMerge(Engine.layer(engine)),
    // The v3 migration the store and the move into wt/ report to, told
    // to the shell from before the store opens.
    Layer.provideMerge(MigrationShell.tellShell),
    Layer.provideMerge(Migration.layer),
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
    // last run left running is reaped here. It claims the records before
    // any script can spawn, and kills in the background.
    Layer.provideMerge(OrphanSweep.layer),
    // Every terminal, each saved for the next start as it closes with
    // the quit.
    Layer.provideMerge(Terminals.layer({ start: terminalStart })),
    // The scripts' changed push, which outlives the quit's kills.
    Layer.provideMerge(scriptsChangedLayer),
    // Every script start and end, which the push above reads.
    Layer.provideMerge(ScriptChanges.layer),
    // Every script run, each in a scope the quit's policy above has
    // already closed or shortened.
    Layer.provideMerge(ScriptRuns.layer),
    Layer.provideMerge(foundation(options.engine)),
  );

// Built from the bottom up, so the scope closes from the top down: read
// downward, this is the quit sequence.
export const layer = (options: {
  readonly hurried: () => boolean;
  readonly engine: Parameters<typeof Engine.layer>[0];
}) =>
  dataDirHolders.pipe(
    Layer.provideMerge(scriptGate),
    // Port forwards start on demand. Stopping them before the remote
    // planes gives their best-effort closes a socket to ride out on.
    Layer.provideMerge(portForwardsLayer),
    // The loopback the terminal reaches the app on. It unpublishes its
    // address first as it stops, so a terminal run during the quit
    // reads "not running" instead of dialing a closing listener.
    Layer.provideMerge(loopbackLayer()),
    Layer.provideMerge(mirrorFollower),
    Layer.provideMerge(mirrorDaemon),
    Layer.provideMerge(mirrorGateway),
    // The mirror's changed push, which the engine above and the
    // served streams feed.
    Layer.provideMerge(mirrorChangesLayer),
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
      BackgroundFetch.layer({
        broadcast: broadcastAll,
        announceProjectChanged,
      }),
    ),
    // Installing the CLI link is a Settings action. A start only
    // repairs an installed link whose target moved (an app update,
    // another checkout).
    Layer.provideMerge(
      starts("the CLI link repair", () => void repairCliLinks(hostFacts())),
    ),
    Layer.provideMerge(firstProjectList),
    // The handlers read this device's copy of the shared settings
    // synchronously.
    Layer.provideMerge(
      logged("the shared settings", SharedSettingsStore.layer),
    ),
    // The moves in flight, each one the quit comes before rolled back.
    Layer.provideMerge(Moves.layer),
    Layer.provideMerge(scriptsAndFoundation(options)),
  );
