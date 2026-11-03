// Every handler the host serves, assembled for the wires. The wires
// themselves are wires.ts (the loopback, the device link, and the hub
// and direct plane's lifecycle). This file is what rides them: each
// host-side module's handlers from host/ipc/modules as one layer
// (hostHandlers), and the host's peer reach over the same peer sessions
// the windows use. The account's changes arrive from the shell
// (applyAccount).
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
import { servedHub } from "@shared/hub/bridgeHandlers";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Schedule from "effect/Schedule";
import { mirrorContract } from "@shigomori/contracts/modules/mirror";
import { callFailureOf } from "@shigomori/contracts/errors";
import { messageOf } from "@shigomori/engine/errorDocument";
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
import { MirrorLedger } from "@host/mirror/MirrorLedger";
import { MirrorEngine } from "@host/mirror/MirrorEngine";
import { ScriptChanges } from "@host/lib/scripts/ScriptChanges";
import * as HostPushes from "@host/lib/HostPushes";
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
import * as SharedSettingsStore from "@host/lib/sharedSettings/store";
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
import * as PeerReach from "@host/ipc/PeerReach";
import * as HostRpc from "@host/socket/hostRpc";
import * as MirrorDaemon from "@host/mirror/MirrorDaemon";
import { dataDir } from "@shared/paths";
import type { AccountFacts } from "@shigomori/contracts/modules/session";
import { HostAccount } from "@host/lib/HostAccount";
import { acceptsPeerCommands, listAccountDevices } from "./account";
import {
  clearDirectTickets,
  refreshHubConnection,
  hubHandlers,
  peerAdmissions,
} from "./wires";
import { log, warnOnFailure } from "@shared/log";
import * as Graph from "./graph";

// The hub's handlers, failing instead of throwing: hubHandlers() throws
// LayerDownError before the hub is up.
const bridge = Effect.try({ try: hubHandlers, catch: callFailureOf });

// The byte channels of a peer's cached session.
const channelsFor = (deviceId: string) => () =>
  Effect.runPromise(hubHandlers().peerChannels(deviceId));

// Every peer reach of the host (host/ipc/PeerReach.ts), the
// pull/transplant orchestrations' and the port-forward engine's among
// them, routed through the SAME invokePeer path (and so the same
// cached direct peer session) the renderer's remote-device api uses.
// Opening a second session directly would supersede-kill the one every
// remote-forest query is riding, since the host keeps one authed
// socket per device.
const peerReachLayer = Layer.effect(
  PeerReach.PeerReach,
  Effect.gen(function* () {
    const runFork = yield* FiberSet.makeRuntime<HostPushes.HostPushes>();
    return PeerReach.make({
      invoke: (deviceId, channel, input) =>
        Effect.flatMap(bridge, (hub) =>
          hub.invokeOnPeer(deviceId, channel, input),
        ),
      // Off the same session's pushes: what a start the peer runs for
      // this device streams back, which the control ops relay to the CLI.
      onPush: (deviceId, channel, handler) => {
        const fiber = runFork(
          Stream.unwrap(HostPushes.payloads(hubContract, "peerPush")).pipe(
            Stream.filter(
              (push) => push.deviceId === deviceId && push.channel === channel,
            ),
            Stream.runForEach((push) =>
              Effect.sync(() => handler(push.payload)),
            ),
          ),
        );
        return () => fiber.interruptUnsafe();
      },
      channelsFor,
      admissions: peerAdmissions.admissions,
      admits: peerAdmissions.admits,
    });
  }),
);

// A change push's window: a burst goes out as one ping this long after
// its first member.
const CHANGE_WINDOW_MS = 150;
// The mirror's changed push, for the length of the graph: each picture
// of the host's own view, to every window and peer. The list is
// validated against its strict schema on the way out, and one that
// fails it goes out as the bare signal (a reader then asks). A picture
// that fails to build (a session the daemon reports that its schema
// rejects) ends the view's read, and the push joins a new one, backing
// off up to a minute.
export const mirrorChangesLayer = Layer.effectDiscard(
  Effect.flatMap(MirrorLedger, (ledger) =>
    ledger.watch.pipe(
      Stream.runForEach((list) =>
        HostPushes.push(mirrorContract, "changed", list).pipe(
          Effect.catchDefect((error) =>
            Effect.sync(() =>
              log.warn(
                `[mirror] the changed broadcast goes without its list: ${messageOf(error)}`,
              ),
            ).pipe(
              Effect.andThen(
                HostPushes.push(mirrorContract, "changed", undefined),
              ),
            ),
          ),
        ),
      ),
      Effect.catchDefect((defect) => Effect.fail(defect)),
      Effect.tapError((error) =>
        Effect.sync(() =>
          log.warn(
            `[mirror] the changed push lost its picture: ${messageOf(error)}`,
          ),
        ),
      ),
      Effect.retry(
        Schedule.min([
          Schedule.exponential("1 second"),
          Schedule.spaced("1 minute"),
        ]),
      ),
      Effect.forkScoped,
    ),
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
        HostPushes.push(scriptsContract, "changed", undefined),
      ),
      Effect.forkScoped,
    ),
  ),
);
const fileSyncDir = () => join(dataDir(), "file-sync");

// Continuous worktree mirroring, this device's half: the daemon
// (host/mirror/MirrorDaemon.ts), which dials peers through the
// gateway (MirrorGateway.ts), and the engine over it
// (MirrorEngineLayer.ts), whose changes go to every window. A boot
// without the engine binary (a dev run before file-sync:build)
// reports "unavailable" and keeps retrying.
export const mirrorDaemonLayer = MirrorDaemon.layer({ dataDir: fileSyncDir });

// Every daemon snapshot and status change, to every window.
export const mirrorDaemonChangesLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const ledger = yield* MirrorLedger;
    yield* (yield* MirrorDaemon.MirrorDaemon).changes.pipe(
      Stream.runForEach(() => Effect.sync(ledger.changed)),
      Effect.forkScoped,
    );
  }),
);

// A step of the account fan-out that must not take the rest with it:
// its failure is a warning in the host's log, and the fan-out goes on.
// It needs no graph, so it runs while one stops too (a sign-out under
// way as the app quits).
function teardownStep(what: string, run: () => unknown): Promise<void> {
  return warnOnFailure(`[account] ${what} failed`, run);
}

// The account's facts as the shell reports them: at start and after
// every sign-in, sign-out, rename, credential rotation or switch flip.
// The first is the baseline, before which the sessions the daemon
// brought back are not asked about (the mirror engine ends them for a
// device signed out at start). A later report tells a rename or a
// switch flip (same account, nothing to tear down) from a departure.
// A departure (a sign-out, since the hub refuses a switch without one)
// tears down what was the account's, in the order the pieces need: the
// mirror sweep before the hub refresh (its terminates ride the sessions
// the refresh closes), the shared settings after it (a peer's push
// landing between the clear and the sessions closing would refill the
// copy). Every step is fenced so one failing cannot leave the remote
// plane up.
export async function applyAccount(next: AccountFacts | null): Promise<void> {
  const previous = await Graph.run(
    Effect.flatMap(HostAccount, (account) => account.set(next)),
  );
  const leaving =
    previous.facts !== null &&
    (next === null || next.accountId !== previous.facts.accountId);
  const first = !previous.reported;
  if (leaving) {
    clearDirectTickets();
    await stopPortForwardsTo(() => false);
    await teardownStep("the mirror sweep", () =>
      Graph.run(Effect.flatMap(MirrorEngine, (engine) => engine.leaveAccount)),
    );
  }
  // The switch as it now stands, to every connected peer (the push is
  // annotated remote), whose bridge records it for its UI and CLI. The
  // windows hear it from the shell, whose account page flipped it. An
  // account switch also restarts the listener, so peers learn it from
  // their next dial either way.
  if (!first && previous.facts?.acceptsCommands !== next?.acceptsCommands) {
    await Graph.run(
      HostPushes.push(
        accountContract,
        "commandAccessChanged",
        acceptsPeerCommands(),
      ),
    );
  }
  // Every report, as the socket's own inputs decide whether anything
  // changed: a device enrolled again under the same account (Retry
  // enrollment) has a new credential and key, and a blocked socket
  // restarts only here. Also reconciles the listener from its tail,
  // which follows the same enrollment condition.
  await refreshHubConnection();
  if (leaving) {
    await teardownStep("dropping the shared settings", () =>
      Graph.run(SharedSettingsStore.clear),
    );
  }
}

// The account's devices as the shell last reported them.
let lastMembership = new Set<string>();

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
    Effect.flatMap(MirrorLedger, (ledger) =>
      ledger.endMirrorsWithPeers(
        stillOn,
        "The other device left the account. The copy stays as a worktree.",
      ),
    ),
  ).catch(() => {});
  // A forward is standing intent across a peer being asleep, so it
  // follows the account's membership, never the roster.
  void stopPortForwardsTo(stillOn);
}

// The services the root provides the graph from its own wiring: the
// peers' reach, and the account the control ops read, its device
// registry riding the stored credential.
export const rootServices = Layer.mergeAll(
  peerReachLayer,
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
        Effect.promise(async () => hubHandlers().status()),
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

// The forwards onto devices no longer on the account, stopped. Before
// the graph is up there are none.
const stopPortForwardsTo = (
  keep: (deviceId: string) => boolean,
): Promise<void> =>
  Graph.runIfUp(
    Effect.flatMap(PortForwards.PortForwards, (engine) =>
      engine.stopForwardsTo(keep),
    ),
  );

// The windows' bridge onto the host's hub socket: status, invokes over
// the keeper-held direct sessions, and the peerPush and statusChanged
// fan-outs. Built in wires.ts, which owns every dep. The bridge is shared
// with the web client, which serves it the same.
const hub = servedHub(hubHandlers);

// Every host-side module, which the loopback and the device link both
// serve. The link's group holds only the remote calls, and its gates
// read each call's own annotations (host/socket/DeviceLink.ts): a peer
// asking for one that is not remote (runtime:nuke, launchers:launch)
// gets the same no-handler answer as for a call the host does not serve.
export const hostHandlers = Layer.mergeAll(
  HostRpc.handlers(hubContract, hub.handlers, hub.views),
  // The listeners belong to this machine, so the surface never mounts
  // on a remote wire.
  HostRpc.handlers(portForwardContract, portForwardHandlers),
  HostRpc.handlers(mirrorContract, mirrorHandlers, mirrorViews),
  HostRpc.handlers(projectsContract, projectsHandlers, projectsViews),
  HostRpc.handlers(runtimeContract, runtimeHandlers),
  HostRpc.handlers(branchesContract, branchesHandlers),
  HostRpc.handlers(
    globalConfigContract,
    globalConfigHandlers,
    globalConfigViews,
  ),
  HostRpc.handlers(portPoolContract, portPoolHandlers),
  HostRpc.handlers(portsContract, portsHandlers, portsViews),
  HostRpc.handlers(terrierContract, terrierHandlers),
  HostRpc.handlers(agentsContract, agentsHandlers),
  HostRpc.handlers(launchersContract, launchersHandlers),
  HostRpc.handlers(packageScriptsContract, packageScriptsHandlers),
  HostRpc.handlers(fsContract, fsHandlers),
  HostRpc.handlers(gitContract, gitHandlers),
  HostRpc.handlers(githubCliContract, githubCliHandlers, githubCliViews),
  HostRpc.handlers(worktreesContract, worktreesHandlers, worktreesViews),
  HostRpc.handlers(hygieneContract, hygieneHandlers),
  HostRpc.handlers(scriptsContract, scriptsHandlers, scriptsViews),
  HostRpc.handlers(terminalsContract, terminalsHandlers, terminalsViews),
  HostRpc.handlers(
    sharedSettingsContract,
    sharedSettingsHandlers,
    sharedSettingsViews,
  ),
  HostRpc.handlers(sharingContract, sharingHandlers, sharingViews),
  HostRpc.handlers(cliContract, cliHandlers),
  HostRpc.handlers(shigomoriContract, shigomoriHandlers),
  HostRpc.handlers(worktreeDataContract, worktreeDataHandlers),
  HostRpc.handlers(syncContract, syncHandlers),
  // Host side of the port-forward wire: host-scoped, so it mounts on
  // the loopback and the direct listener, whose command-access gate
  // covers every verb (all gated).
  HostRpc.handlers(forwardContract, forwardHandlers),
  // Host-scoped: a peer's Settings page reads this device's update
  // state and, when granted, checks or restarts into an update here.
  HostRpc.handlers(updaterContract, updaterHandlers),
  // Local only: the villager data in this device's data dir, for its
  // own window's Village life.
  HostRpc.handlers(villagersContract, villagersHandlers),
);

// The loopback's alone: the terminal's cross-device verbs
// (packages/contracts/src/modules/control.ts), over the account
// (rootServices) and the peers' reach, and the guide's drive.
export const loopbackHandlers = Layer.mergeAll(
  HostRpc.handlers(controlContract, controlHandlers, controlTransfers),
  HostRpc.handlers(guideDriveContract, guideDriveHandlers),
);
