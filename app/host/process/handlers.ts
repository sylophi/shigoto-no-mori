// Every handler the host serves, assembled and put on the wires. The
// wires themselves are wires.ts (the loopback, the device link, and the
// hub and direct plane's lifecycle). This file is what rides them: it
// builds each host-side module's handler map from host/ipc/modules,
// gives the host's peer reach the same peer sessions the windows use,
// and registers the lot in registerHostHandlers, once at start. The
// account's changes arrive from the shell (applyAccount).
import { join } from "node:path";
import { accountContract } from "@shigomori/contracts/modules/account";
import { branchesContract } from "@shigomori/contracts/modules/branches";
import { forwardContract } from "@shigomori/contracts/modules/forward";
import { fsContract } from "@shigomori/contracts/modules/fs";
import { gitContract } from "@shigomori/contracts/modules/git";
import { githubCliContract } from "@shigomori/contracts/modules/githubCli";
import { globalConfigContract } from "@shigomori/contracts/modules/globalConfig";
import { hygieneContract } from "@shigomori/contracts/modules/hygiene";
import { launchersContract } from "@shigomori/contracts/modules/launchers";
import { servedInvokePeer, servedWatchPeer } from "@shared/hub/bridgeHandlers";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  MirrorWorktreePayloadSchema,
  mirrorContract,
} from "@shigomori/contracts/modules/mirror";
import { callFailureOf } from "@shigomori/contracts/errors";
import { errorWordsOf } from "@host/lib/errorWords";
import { packageScriptsContract } from "@shigomori/contracts/modules/packageScripts";
import { portForwardContract } from "@shigomori/contracts/modules/portForward";
import { portPoolContract } from "@shigomori/contracts/modules/portPool";
import { portsContract } from "@shigomori/contracts/modules/ports";
import { projectsContract } from "@shigomori/contracts/modules/projects";
import { hubContract } from "@shigomori/contracts/modules/hub";
import { runtimeContract } from "@shigomori/contracts/modules/runtime";
import { scriptsContract } from "@shigomori/contracts/modules/scripts";
import { sharedSettingsContract } from "@shigomori/contracts/modules/sharedSettings";
import { sharingContract } from "@shigomori/contracts/modules/sharing";
import { terminalsContract } from "@shigomori/contracts/modules/terminals";
import { cliContract } from "@shigomori/contracts/modules/cli";
import { controlContract } from "@shigomori/contracts/modules/control";
import { guideDriveContract } from "@shigomori/contracts/modules/guide";
import { terrierContract } from "@shigomori/contracts/modules/terrier";
import { agentsContract } from "@shigomori/contracts/modules/agents";
import { shigomoriContract } from "@shigomori/contracts/modules/shigomori";
import { worktreeDataContract } from "@shigomori/contracts/modules/worktreeData";
import { syncContract } from "@shigomori/contracts/modules/sync";
import { updaterContract } from "@shigomori/contracts/modules/updater";
import { villagersContract } from "@shigomori/contracts/modules/villagers";
import { worktreesContract } from "@shigomori/contracts/modules/worktrees";
import { branchesHandlers } from "@host/ipc/modules/branches";
import { forwardHandlers } from "@host/ipc/modules/forward";
import { fsHandlers } from "@host/ipc/modules/fs";
import { gitHandlers } from "@host/ipc/modules/git";
import { githubCliHandlers, githubCliViews } from "@host/ipc/modules/githubCli";
import {
  globalConfigHandlers,
  globalConfigViews,
} from "@host/ipc/modules/globalConfig";
import { hygieneHandlers } from "@host/ipc/modules/hygiene";
import { launchersHandlers } from "@host/ipc/modules/launchers";
import { mirrorHandlers, mirrorViews } from "@host/ipc/modules/mirror";
import { currentMirrorList } from "@host/mirror/sessions";
import {
  createNoAccountSweep,
  endMirrorsOnPeerRemoval,
  endMirrorsWithPeers,
  LEFT_ACCOUNT_DETAIL,
} from "@host/mirror/registry";
import { MirrorEngine } from "@host/mirror/MirrorEngine";
import * as MirrorEngineLayer from "@host/mirror/MirrorEngineLayer";
import { MirrorSignals } from "@host/mirror/MirrorSignals";
import { ScriptChanges } from "@host/lib/scripts/ScriptChanges";
import { packageScriptsHandlers } from "@host/ipc/modules/packageScripts";
import { portForwardHandlers } from "@host/ipc/modules/portForward";
import * as PortForwards from "@host/portForward/PortForwards";
import { portPoolHandlers } from "@host/ipc/modules/portPool";
import { portsHandlers, portsViews } from "@host/ipc/modules/ports";
import { projectsHandlers, projectsViews } from "@host/ipc/modules/projects";
import { runtimeHandlers } from "@host/ipc/modules/runtime";
import { scriptsHandlers, scriptsViews } from "@host/ipc/modules/scripts";
import {
  sharedSettingsHandlers,
  sharedSettingsViews,
} from "@host/ipc/modules/sharedSettings";
import {
  onSharedSettingsChange,
  sharedSettingsCopy,
} from "@host/lib/sharedSettings/store";
import { cliHandlers } from "@host/ipc/modules/cli";
import { sharingHandlers, sharingViews } from "@host/ipc/modules/sharing";
import { terminalsHandlers, terminalsViews } from "@host/ipc/modules/terminals";
import { controlHandlers, controlTransfers } from "@host/ipc/modules/control";
import { guideDriveHandlers } from "@host/ipc/modules/guideDrive";
import {
  AccountPeers,
  listDevicesFailure,
  withinAccountRead,
} from "@host/lib/control/AccountPeers";
import { terrierHandlers } from "@host/ipc/modules/terrier";
import { agentsHandlers } from "@host/ipc/modules/agents";
import { shigomoriHandlers } from "@host/ipc/modules/shigomori";
import { worktreeDataHandlers } from "@host/ipc/modules/worktreeData";
import { syncHandlers } from "@host/ipc/modules/sync";
import { updaterHandlers } from "@host/ipc/modules/updater";
import { villagersHandlers } from "@host/ipc/modules/villagers";
import { worktreesHandlers, worktreesViews } from "@host/ipc/modules/worktrees";
import type { ClientTransport } from "@shared/ipc/transport";
import * as PeerReach from "@host/ipc/PeerReach";
import * as MirrorDaemon from "@host/mirror/MirrorDaemon";
import { ProjectScopedPayloadSchema } from "@shigomori/contracts/schemas/payloads";
import { dataDir } from "@shared/paths";
import {
  type AccountFacts,
  acceptsPeerCommands,
  accountSignedIn,
  listAccountDevices,
  setAccountFacts,
} from "./account";
import {
  broadcastAll,
  clearDirectTickets,
  refreshHubConnection,
  registerContract,
  registerLoopbackContract,
  registerViews,
  hubHandlers,
  onPeerPush,
} from "./wires";
import { log, warnOnFailure } from "@shared/log";
import * as Graph from "./graph";

// The pull/transplant orchestrations' and the port-forward engine's
// peer reach, routed through the SAME invokePeer path (and so the same
// cached direct peer session) the renderer's remote-device api uses.
// Opening a second session directly would supersede-kill the one every
// remote-forest query is riding, since the host keeps one authed
// socket per device.
const peerTransportFor = (deviceId: string): ClientTransport => ({
  invoke: (channel, input, options) =>
    hubHandlers().invokeOnPeer(deviceId, channel, input, options),
  // One channel of the peer's pushes, off the same session's fan-out
  // (onPeerPush): what a start the peer runs for this device streams
  // back, which the control ops relay to the CLI.
  subscribe: (channel: string, handler: (payload: unknown) => void) =>
    onPeerPush((push) => {
      if (push.deviceId === deviceId && push.channel === channel) {
        handler(push.payload);
      }
    }),
});

// Every peer reach of the host (host/ipc/PeerReach.ts), riding
// peerTransportFor above and the byte channels of the same session.
const peerReach = PeerReach.make({
  transportFor: peerTransportFor,
  channelsFor: (deviceId) => () => hubHandlers().peerChannels(deviceId),
});

// A change push's window: a burst goes out as one ping this long after
// its first member.
const CHANGE_WINDOW_MS = 150;
// The daemon snapshots on every cycle of every session and the
// follower reports every verdict. The renderer's ping goes out once a
// window (mirrorChangesLayer), so a busy mirror costs viewers one
// re-read per beat, not one per cycle. One change waiting is all a
// burst needs.
const mirrorChanges = Effect.runSync(Queue.sliding<void>(1));
const broadcastMirrorChanged = () =>
  void Queue.offerUnsafe(mirrorChanges, undefined);
const pushMirrorChanged = () =>
  void Graph.run(currentMirrorList).then(
    (list) => {
      // The list is validated against its strict schema on the way
      // out, and one that fails it goes out as the bare signal (a
      // reader then asks).
      try {
        broadcastAll(mirrorContract, "changed", list);
      } catch (error) {
        log.warn(
          `[mirror] the changed broadcast goes without its list: ${errorWordsOf(error)}`,
        );
        broadcastAll(mirrorContract, "changed", undefined);
      }
    },
    () => {},
  );
// The mirror's changed push, for the length of the graph.
export const mirrorChangesLayer = Layer.effectDiscard(
  Stream.fromQueue(mirrorChanges).pipe(
    Stream.groupedWithin(Infinity, CHANGE_WINDOW_MS),
    Stream.runForEach(() => Effect.sync(pushMirrorChanged)),
    Effect.forkScoped,
  ),
);
// Every script start and end, whoever ran it, to every window and
// peer, for the length of the graph. A burst (a lifecycle starting
// setup and port-pool together, a project's scripts stopped at once)
// goes out as one ping.
export const scriptsChangedLayer = Layer.effectDiscard(
  Effect.flatMap(ScriptChanges, ({ changes }) =>
    changes.pipe(
      Stream.groupedWithin(Infinity, CHANGE_WINDOW_MS),
      Stream.runForEach(() =>
        Effect.sync(() => broadcastAll(scriptsContract, "changed", undefined)),
      ),
      Effect.forkScoped,
    ),
  ),
);
const fileSyncDir = () => join(dataDir(), "file-sync");
const decodeMirrorWorktreePayload = Schema.decodeUnknownOption(
  MirrorWorktreePayloadSchema,
);
// The daemon's sessions as they stand, for the root's synchronous
// callbacks: none before the graph is up.
export const mirrorSessionsNow = () =>
  Graph.readNow(
    MirrorDaemon.onDaemon((daemon) => daemon.sessions),
    () => [],
  );

// Continuous worktree mirroring, this device's half: the daemon
// (host/mirror/MirrorDaemon.ts), which dials peers through the
// gateway (MirrorGateway.ts), and the engine over it
// (MirrorEngineLayer.ts), whose changes go to every window. A boot
// without the engine binary (a dev run before file-sync:build)
// reports "unavailable" and keeps retrying.
export const mirrorDaemonLayer = MirrorDaemon.layer({ dataDir: fileSyncDir });
export const mirrorEngineLayer = MirrorEngineLayer.layer({
  onChange: broadcastMirrorChanged,
  projectChanged: (projectId) =>
    broadcastAll(gitContract, "projectChanged", { projectId }),
});
// Every daemon snapshot and status change, to every window and to the
// sweep of sessions the engine brings back for a device on no account.
export const mirrorDaemonChangesLayer = Layer.effectDiscard(
  Effect.flatMap(MirrorDaemon.MirrorDaemon, (daemon) =>
    daemon.changes.pipe(
      Stream.runForEach(() =>
        Effect.try(() => {
          broadcastMirrorChanged();
          noAccountSweep.run();
        }).pipe(
          Effect.catch((error) =>
            Effect.logWarning(
              `[mirror] a daemon change listener failed: ${errorWordsOf(error)}`,
            ),
          ),
        ),
      ),
      Effect.forkScoped,
    ),
  ),
);
const endAllMirrors = () =>
  Graph.run(
    endMirrorsWithPeers(() => false, LEFT_ACCOUNT_DETAIL, {
      transfers: true,
    }),
  );
// The sessions the engine brings back for a device on no account
// (registry.ts createNoAccountSweep). The account fan-out's own sweep
// covers a sign-out with the daemon up, and resets this one.
const noAccountSweep = createNoAccountSweep({
  sessions: mirrorSessionsNow,
  fresh: () =>
    Graph.readNow(
      MirrorDaemon.onDaemon((daemon) => daemon.fresh),
      () => false,
    ),
  signedIn: accountSignedIn,
  end: () => void endAllMirrors().catch(() => {}),
});

// The command-access switch as it now stands, to every connected peer
// (the push is annotated remote). The windows hear it from the shell,
// whose account page flipped it.
function broadcastCommandAccessChanged(): void {
  broadcastAll(accountContract, "commandAccessChanged", acceptsPeerCommands());
}

// A step of the account fan-out that must not take the rest with it:
// its failure is a warning in the host's log, and the fan-out goes on.
// It needs no graph, so it runs while one stops too (a sign-out under
// way as the app quits).
function teardownStep(what: string, run: () => unknown): Promise<void> {
  return warnOnFailure(`[account] ${what} failed`, run);
}

// "This project's git state moved on this machine": the project-scoped
// ping on every wire (this window and every device viewing this host
// refetch that project's rows), and the mirror's git follower
// re-looking at every session in the project (a commit or checkout
// here must reach the peer). Sent by the git-directory watcher for
// every ref move, and by the app-run git commands that tell it at once
// rather than wait out the watcher's debounce.
export function announceProjectChanged(projectId: string): void {
  broadcastAll(gitContract, "projectChanged", { projectId });
  toMirrorEngine((engine) => engine.localProjectChanged(projectId));
}

// The mirror engine told something now. Before the graph is up nothing
// is following yet.
const toMirrorEngine = (tell: (engine: MirrorEngine["Service"]) => void) =>
  Graph.readNow(Effect.map(MirrorEngine, tell), () => undefined);

// The account the peer-facing state was built under, so a change can
// tell a rename or a switch flip (same account, nothing to tear down)
// from a departure. Unknown until the shell's first report, at start,
// which is the baseline: a device signed out at start has its resumed
// mirrors swept by noAccountSweep instead.
let started = false;
let lastMembership = new Set<string>();

// The account's facts as the shell reports them: at start and after
// every sign-in, sign-out, rename, credential rotation or switch flip.
// A departure (a sign-out, since the hub refuses a switch without one)
// tears down what was the account's, in the order the pieces need: the
// mirror sweep before the hub refresh (its terminates ride the sessions
// the refresh closes), the shared settings after it (a peer's push
// landing between the clear and the sessions closing would refill the
// copy). Every step is fenced so one failing cannot leave the remote
// plane up.
export async function applyAccount(next: AccountFacts | null): Promise<void> {
  const previous = await setAccountFacts(next);
  const leaving =
    started &&
    previous !== null &&
    (next === null || next.accountId !== previous.accountId);
  const first = !started;
  started = true;
  if (leaving) {
    clearDirectTickets();
    stopPortForwardsTo(() => false);
    await teardownStep("the mirror sweep", () =>
      Graph.run(Effect.flatMap(MirrorEngine, (engine) => engine.leaveAccount)),
    );
    // After the sweep, so a snapshot during it does not sweep again.
    noAccountSweep.reset();
  }
  // The switch as it now stands, to every connected peer, whose bridge
  // records it for its UI and CLI. An account switch also restarts the
  // listener, so peers learn it from their next dial either way.
  if (!first && previous?.acceptsCommands !== next?.acceptsCommands) {
    broadcastCommandAccessChanged();
  }
  // Every report, as the socket's own inputs decide whether anything
  // changed: a device enrolled again under the same account (Retry
  // enrollment) has a new credential and key, and a blocked socket
  // restarts only here. Also reconciles the listener from its tail,
  // which follows the same enrollment condition.
  await refreshHubConnection();
  if (leaving) {
    await teardownStep("dropping the shared settings", () =>
      sharedSettingsCopy.clear(),
    );
  }
}

// The account's registry as the hub last listed it, which the shell
// reports on every read. It is the one place this device learns a peer
// was removed from the account (the hub pushes no such thing, and an
// absent peer looks like an offline one on the roster). A mirror or a
// forward with a device no longer on the account ends here, the other
// half of the departure rule above.
export function noteAccountDevices(deviceIds: ReadonlyArray<string>): void {
  // Only a membership change sweeps: the list is read on every window
  // focus, and the sweeps walk every session and forward.
  const onAccount = new Set(deviceIds);
  const same =
    onAccount.size === lastMembership.size &&
    [...onAccount].every((id) => lastMembership.has(id));
  if (same) return;
  lastMembership = onAccount;
  const stillOn = (deviceId: string) => onAccount.has(deviceId);
  void Graph.run(
    endMirrorsWithPeers(
      stillOn,
      "The other device left the account. The copy stays as a worktree.",
      { transfers: true },
    ),
  ).catch(() => {});
  // A forward is standing intent across a peer being asleep, so it
  // follows the account's membership, never the roster.
  stopPortForwardsTo(stillOn);
}

// The services the root provides the graph from its own wiring: the
// peers' reach, what the mirror's serving side tells, and the account
// the control ops read, its device registry riding the stored
// credential.
export const rootServices = Layer.mergeAll(
  Layer.succeed(PeerReach.PeerReach, peerReach),
  Layer.succeed(
    MirrorSignals,
    MirrorSignals.of({
      // The serving set (streams this host serves for peers) fans out
      // on the mirror's changed push.
      servingChanged: broadcastMirrorChanged,
      // A served worktree's index moved: to the device mirroring it
      // (remote, so it rides the peer push path to the follower there).
      gitChanged: (change) =>
        broadcastAll(mirrorContract, "gitChanged", change),
      // A peer's follower landed its side here (a push into a copy):
      // the pages showing the project refetch, as for the follower's
      // own pulls.
      gitApplied: announceProjectChanged,
    }),
  ),
  Layer.succeed(
    AccountPeers,
    AccountPeers.of({
      listDevices: withinAccountRead(
        Effect.tryPromise({
          try: (signal) => listAccountDevices(signal),
          catch: listDevicesFailure,
        }),
      ),
      directPeers: Effect.map(
        Effect.promise(async () => hubHandlers().status(undefined, undefined)),
        (status) =>
          Object.fromEntries(
            Object.entries(status.peerAcceptsCommands).map(
              ([deviceId, acceptsCommands]) => [
                deviceId,
                {
                  acceptsCommands,
                  sharesData: status.peerSharesData[deviceId] ?? true,
                },
              ],
            ),
          ),
      ),
    }),
  ),
);

// The port forwards, whose changes go to every window.
export const portForwardsLayer = PortForwards.layer({
  onChange: () => broadcastAll(portForwardContract, "changed", undefined),
});

// The forwards onto devices no longer on the account, stopped. Before
// the graph is up there are none.
const stopPortForwardsTo = (keep: (deviceId: string) => boolean): void =>
  Graph.readNow(
    Effect.map(PortForwards.PortForwards, (engine) =>
      engine.stopForwardsTo(keep),
    ),
    () => undefined,
  );

export function registerHostHandlers(): void {
  // This device's copy of the shared settings moved (a pick here, or a
  // peer's entries merged in): every window re-reads it off the push,
  // and every peer's window folds it into its own copy.
  onSharedSettingsChange((doc) =>
    broadcastAll(sharedSettingsContract, "changed", doc),
  );
  // The windows' bridge onto the host's hub socket: status, invokes
  // over the keeper-held direct sessions, and the peerPush and
  // statusChanged fan-outs. Built in wires.ts, which owns every dep.
  // The bridge is shared with the web client, which serves it as
  // Promises: each call answers here as an effect.
  registerContract(hubContract, {
    status: () =>
      Effect.tryPromise({
        try: async () => hubHandlers().status(undefined, undefined),
        catch: callFailureOf,
      }),
    invokePeer: servedInvokePeer(hubHandlers),
  });
  registerViews(hubContract, {
    watchPeer: servedWatchPeer(hubHandlers),
  });
  // The listeners belong to this machine, so the surface never mounts
  // on a remote wire.
  registerContract(portForwardContract, portForwardHandlers);
  // The follower's peer-side signals: a peer's git state moved (its
  // git-directory watcher) or a served worktree's index did. And a
  // peer's worktree gone, which ends the mirrors into it running here.
  onPeerPush((push) => {
    if (push.channel === "git:projectChanged") {
      const { payload } = push;
      if (Schema.is(ProjectScopedPayloadSchema)(payload)) {
        toMirrorEngine((engine) =>
          engine.peerProjectChanged(push.deviceId, payload.projectId),
        );
      }
    } else if (push.channel === "mirror:gitChanged") {
      const parsed = decodeMirrorWorktreePayload(push.payload);
      if (Option.isSome(parsed)) {
        toMirrorEngine((engine) =>
          engine.peerWorktreeChanged(
            push.deviceId,
            parsed.value.projectId,
            parsed.value.worktreeId,
          ),
        );
      }
    } else if (push.channel === "worktrees:removal") {
      void Graph.run(
        endMirrorsOnPeerRemoval(push.deviceId, push.payload),
      ).catch(() => {});
    }
  });
  registerContract(mirrorContract, mirrorHandlers);
  registerViews(mirrorContract, mirrorViews);
  registerContract(projectsContract, projectsHandlers);
  registerViews(projectsContract, projectsViews);
  registerContract(runtimeContract, runtimeHandlers);
  registerContract(branchesContract, branchesHandlers);
  registerContract(globalConfigContract, globalConfigHandlers);
  registerViews(globalConfigContract, globalConfigViews);
  registerContract(portPoolContract, portPoolHandlers);
  registerContract(portsContract, portsHandlers);
  registerViews(portsContract, portsViews);
  registerContract(terrierContract, terrierHandlers);
  registerContract(agentsContract, agentsHandlers);
  registerContract(launchersContract, launchersHandlers);
  registerContract(packageScriptsContract, packageScriptsHandlers);
  registerContract(fsContract, fsHandlers);
  registerContract(gitContract, gitHandlers);
  registerContract(githubCliContract, githubCliHandlers);
  registerViews(githubCliContract, githubCliViews);
  registerContract(worktreesContract, worktreesHandlers);
  registerViews(worktreesContract, worktreesViews);
  registerContract(hygieneContract, hygieneHandlers);
  registerContract(scriptsContract, scriptsHandlers);
  registerViews(scriptsContract, scriptsViews);
  registerContract(terminalsContract, terminalsHandlers);
  registerViews(terminalsContract, terminalsViews);
  registerContract(sharedSettingsContract, sharedSettingsHandlers);
  registerViews(sharedSettingsContract, sharedSettingsViews);
  registerContract(sharingContract, sharingHandlers);
  registerViews(sharingContract, sharingViews);
  registerContract(cliContract, cliHandlers);
  // The terminal's cross-device verbs, on the loopback alone
  // (packages/contracts/src/modules/control.ts), over the account
  // (rootServices) and the peers' reach.
  registerLoopbackContract(controlContract, controlHandlers, controlTransfers);
  registerLoopbackContract(guideDriveContract, guideDriveHandlers);
  registerContract(shigomoriContract, shigomoriHandlers);
  registerContract(worktreeDataContract, worktreeDataHandlers);
  registerContract(syncContract, syncHandlers);
  // Host side of the port-forward wire: host-scoped, so it mounts on
  // the loopback and the direct listener, whose command-access
  // gate covers every verb (all gated).
  registerContract(forwardContract, forwardHandlers);
  // Host-scoped: a peer's Settings page reads this device's update
  // state and, when granted, checks or restarts into an update here.
  registerContract(updaterContract, updaterHandlers);
  // Local only: the villager data in this device's data dir, for its
  // own window's Village life.
  registerContract(villagersContract, villagersHandlers);
}
