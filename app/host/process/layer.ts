// The host's layer graph: what this machine serves, from the scripts it
// runs to the wires its peers, its windows and the terminal reach it
// on. It depends on nothing of the shell's (main/shellLayer.ts), which
// starts it. Each subsystem here is a lifetime: acquiring it starts the
// subsystem, and the scope closing stops it.
import { updaterContract } from "@shigomori/contracts/modules/updater";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as DeviceId from "@host/lib/config/DeviceId";
import * as HostAccount from "@host/lib/HostAccount";
import * as HostPushes from "@host/lib/HostPushes";
import { DataDirHolders } from "@host/lib/DataDirHolders";
import * as HostRpc from "@host/socket/hostRpc";
import * as Loopback from "@host/socket/Loopback";
import * as ProjectSettingsSync from "@host/lib/sharedSettings/projectSettings";
import * as SharedSettingsStore from "@host/lib/sharedSettings/store";
import * as Scripts from "@host/lib/Scripts";
import * as Engine from "@host/lib/Engine";
import * as StoreChanges from "@host/lib/storeChanges";
import * as EngineStoreChanges from "@shigomori/engine/StoreChanges";
import { HoldersOnDelete } from "@shigomori/engine/HoldersOnDelete";
import { MirrorsOnDelete } from "@shigomori/engine/MirrorsOnDelete";
import { mirrorsOnDelete } from "@host/mirror/onDelete";
import * as Shell from "@host/lib/Shell";
import * as CliShell from "@host/lib/cli/shell";
import * as GithubCli from "@host/lib/githubCli/GithubCli";
import * as PullRequestMaps from "@host/lib/githubCli/PullRequestMaps";
import * as Views from "@host/lib/Views";
import * as Ports from "@host/lib/Ports";
import * as ScriptRuns from "@host/lib/scripts/ScriptRuns";
import * as ProcessTrees from "@host/lib/scripts/ProcessTrees";
import * as ScriptChanges from "@host/lib/scripts/ScriptChanges";
import * as Terminals from "@host/lib/terminals/Terminals";
import { terminalStart, terminalWorktrees } from "@host/ipc/scriptRun";
import * as Villagers from "@host/lib/VillagerData";
import * as Worktrees from "@host/lib/Worktrees";
import * as GitWatcher from "@host/lib/GitWatcher";
import * as BackgroundFetch from "@host/lib/BackgroundFetch";
import { repairCliLinks } from "@host/lib/cli/install";
import * as OrphanSweep from "@host/lib/scripts/OrphanSweep";
import * as Moves from "@host/lib/sync/Moves";
import * as MoveQueue from "@host/lib/sync/MoveQueue";
import * as FileSyncRunner from "@host/fileSync/runner";
import * as MirrorGateway from "@host/mirror/MirrorGateway";
import * as MirrorEngineLayer from "@host/mirror/MirrorEngineLayer";
import * as MirrorLedger from "@host/mirror/MirrorLedger";
import * as PeerRemovals from "@host/mirror/peerRemovals";
import * as ScratchIndex from "@host/mirror/ScratchIndex";
import * as PortForwards from "@host/portForward/PortForwards";
import * as Sharing from "@host/lib/Sharing";
import {
  hostHandlers,
  loopbackHandlers,
  mirrorChangesLayer,
  mirrorDaemonChangesLayer,
  mirrorDaemonLayer,
  rootServices,
  scriptsChangedLayer,
} from "./handlers";
import {
  deviceLinkLayer,
  loopbackLayer,
  remotePlanesLayer,
  tunnelLayer,
  followDeviceSettings,
  refreshDirectHost,
} from "./wires";
import { onQuit, starts } from "@shared/lifetimes";
import * as Migration from "@shigomori/engine/Migration";
import { hostFacts } from "./facts";
import * as Graph from "./graph";
import * as MigrationShell from "./migration";

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

// Git state inside every project (commits, checkouts, refs written by
// any tool), as a project-scoped ping on every wire.
const gitWatcher = logged("the git watcher", GitWatcher.layer);

// The hub socket and the direct plane, and the device link's listener,
// which follows the same enrollment condition. Both connect on the
// account's first report from the shell and reconcile on every one
// after (handlers.ts applyAccount). The listener closes with its own
// layer, below.
const remotePlanes = logged("the device hub", remotePlanesLayer);

// The mirror engine: the git follower and the threads, the daemon, and
// the gateway the daemon dials peers through. The daemon resumes
// persisted sessions the moment it is up, so it starts with the app.
// The sessions it resumes are swept for a device on no account once the
// shell's first account report lands (MirrorEngineLayer.ts).
const mirrors = MirrorEngineLayer.layer.pipe(
  Layer.provideMerge(mirrorDaemonChangesLayer),
  Layer.provideMerge(mirrorDaemonLayer),
  Layer.provideMerge(MirrorGateway.layer),
);

// New scripts are refused from the moment the quit begins, so none
// starts after the reap at the end has looked.
const scriptGate = onQuit(
  "the script gate",
  Effect.flatMap(Scripts.Scripts, (it) => it.refuseNew),
);

// What lets go of the data folder before a move takes it away: the
// store, the updater's bridge and the loopback's address file. The
// updater stops starting anything earlier, as the move's last check
// (holdUpdater).
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

// The updater's state as the shell reports it, to every window and
// peer.
const updaterStates = Layer.effectDiscard(
  Effect.gen(function* () {
    const pushes = yield* HostPushes.HostPushes;
    const states = yield* (yield* Shell.Shell).updater.states;
    yield* states.pipe(
      Stream.runForEach((state) =>
        pushes.publish(updaterContract, "state", state),
      ),
      Effect.forkScoped,
    );
  }),
);

// What the host answers from caches: other tools' (gh, its PR maps
// and port-pool) and the login shell's config place.
const cachedAnswers = Layer.mergeAll(
  PullRequestMaps.layer.pipe(Layer.provideMerge(GithubCli.layer)),
  CliShell.layer,
  Ports.layer,
);

// The bottom of the graph, closed last.
const foundation = (
  engine: Parameters<typeof Engine.layer>[0],
  migration: Migration.Migration["Service"],
) =>
  cachedAnswers.pipe(
    // A villager download under way stops here, and resumes next launch.
    Layer.provideMerge(Villagers.deviceLayer),
    // The scratch copies of the index the mirrors' git reads take, for
    // the follower and the peers' calls alike.
    Layer.provideMerge(ScratchIndex.layer),
    // The views' shared reads, over every push the host makes and every
    // store write.
    Layer.provideMerge(Views.layer),
    // The engine's deletes stop the mirrors of what they take first.
    Layer.provideMerge(Layer.effect(MirrorsOnDelete, mirrorsOnDelete("both"))),
    // What the host keeps about its mirrors while it works on them, which
    // those deletes, the scripts' tombstone and the mirror engine share.
    Layer.provideMerge(MirrorLedger.layer),
    Layer.provideMerge(updaterStates),
    // What the root provides from its own wiring: the peers' reach and
    // the account's peers.
    Layer.provideMerge(rootServices),
    // Every push the host makes, which the wires, the views and the
    // host's own followers read, and every store write.
    Layer.provideMerge(HostPushes.layer),
    Layer.provideMerge(EngineStoreChanges.layer),
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
    // to the shell from before the store opens. Made before the graph,
    // so a graph that fails still has it to tell (host.ts).
    Layer.provideMerge(MigrationShell.tellShell),
    Layer.provideMerge(Layer.succeed(Migration.Migration, migration)),
  );

// The lower half of the graph below: the file-sync children, the
// scripts and the foundation, closed last.
const scriptsAndFoundation = (options: {
  readonly hurried: () => boolean;
  readonly engine: Parameters<typeof Engine.layer>[0];
  readonly migration: Migration.Migration["Service"];
}) =>
  // Every file-sync child, the daemon and the serve children a peer's
  // streams opened.
  FileSyncRunner.layer.pipe(
    // What the user started through a script must not outlive the app,
    // orphaned to launchd: its close stops every run.
    Layer.provideMerge(
      Scripts.layer({ hurried: options.hurried, env: () => process.env }),
    ),
    // A crash, a force quit or an OOM skips the quit's reap, so what the
    // last run left running is reaped here. It claims the records before
    // any script can spawn, and kills in the background.
    Layer.provideMerge(OrphanSweep.layer),
    // The engine's deletes close the terminals in what they take first.
    Layer.provideMerge(
      Layer.effect(
        HoldersOnDelete,
        Effect.map(Terminals.Terminals, (terminals) =>
          HoldersOnDelete.of({ release: terminals.closeOf }),
        ),
      ),
    ),
    // Every terminal, each saved for the next start as it closes with
    // the quit.
    Layer.provideMerge(
      Terminals.layer({
        start: terminalStart,
        worktrees: terminalWorktrees,
      }),
    ),
    // The scripts' changed push, which outlives the quit's kills.
    Layer.provideMerge(scriptsChangedLayer),
    // Every script start and end, which the push above reads.
    Layer.provideMerge(ScriptChanges.layer),
    // Every script run, each in a scope the quit's policy above has
    // already closed or shortened.
    Layer.provideMerge(ScriptRuns.layer),
    // How the scripts, the terminals and the sweep end a process tree.
    Layer.provideMerge(ProcessTrees.layer),
    Layer.provideMerge(foundation(options.engine, options.migration)),
  );

// Handlers whose calls run on the graph as it is when each comes.
const onGraph = (handlers: HostRpc.HandlerLayer) =>
  handlers.pipe(
    Layer.provide(Layer.succeed(HostRpc.HostGraph, Graph.services)),
  );

// Built once, for both listeners.
const served = onGraph(hostHandlers);

// Built from the bottom up, so the scope closes from the top down: read
// downward, this is the quit sequence.
export const layer = (options: {
  readonly hurried: () => boolean;
  readonly engine: Parameters<typeof Engine.layer>[0];
  readonly migration: Migration.Migration["Service"];
  // What the loopback serves beside every host module: the shell's
  // session, and the entry's own.
  readonly loopback: HostRpc.HandlerLayer;
}) =>
  // The moves queued on another device run on everything below, and
  // go first: a queued move running at the quit is rolled back while
  // what it runs on is still up.
  MoveQueue.layer.pipe(Layer.provideMerge(below(options)));

const below = (options: Parameters<typeof layer>[0]) =>
  dataDirHolders.pipe(
    Layer.provideMerge(scriptGate),
    // Port forwards start on demand. Stopping them before the remote
    // planes gives their best-effort closes a socket to ride out on.
    Layer.provideMerge(PortForwards.layer),
    // The loopback the terminal reaches the app on. It unpublishes its
    // address first as it stops, so a terminal run during the quit
    // reads "not running" instead of dialing a closing listener.
    Layer.provideMerge(
      loopbackLayer.pipe(
        Layer.provide(
          Layer.mergeAll(
            served,
            onGraph(Layer.mergeAll(loopbackHandlers, options.loopback)),
          ),
        ),
      ),
    ),
    // A peer's worktree gone, which ends the mirrors into it and takes
    // the originals here a delete of both sides stood for.
    Layer.provideMerge(PeerRemovals.layer),
    // The worktree moves and removals, around the scripts and terminals
    // they stop and refuse for and the mirrors they carry or end, and the
    // carry-over reads.
    Layer.provideMerge(Worktrees.layer),
    // The mirror's changed push, over the engine whose sessions it lists.
    Layer.provideMerge(mirrorChangesLayer),
    Layer.provideMerge(mirrors),
    Layer.provideMerge(remotePlanes),
    Layer.provideMerge(followDeviceSettings(Effect.promise(refreshDirectHost))),
    // The cloudflared child, fronting the device link's listener.
    Layer.provideMerge(tunnelLayer),
    // The listener peers dial, which connected peers see go away
    // cleanly.
    Layer.provideMerge(deviceLinkLayer.pipe(Layer.provide(served))),
    // The switch the listener's gate reads. Its changes go to this
    // device's windows and, the push being remote, to every peer.
    Layer.provideMerge(Sharing.layer),
    // Every store write, the terminal's or the app's own, as pushes, and
    // what the scripts and the projects' git watches follow of it.
    Layer.provideMerge(logged("the store's changes", StoreChanges.layer)),
    Layer.provideMerge(gitWatcher),
    Layer.provideMerge(BackgroundFetch.layer),
    // Installing the CLI link is a Settings action. A start only
    // repairs an installed link whose target moved (an app update,
    // another checkout).
    Layer.provideMerge(
      starts("the CLI link repair", () => void repairCliLinks(hostFacts())),
    ),
    Layer.provideMerge(
      logged("the synced project settings", ProjectSettingsSync.layer),
    ),
    // Every commit to the shared settings, by any writer, announced to
    // every window and peer.
    Layer.provideMerge(SharedSettingsStore.layer),
    // The moves in flight, each one the quit comes before rolled back.
    Layer.provideMerge(Moves.layer),
    Layer.provideMerge(scriptsAndFoundation(options)),
  );
