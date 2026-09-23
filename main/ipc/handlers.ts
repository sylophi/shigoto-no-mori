// Every handler this device serves, assembled and put on the wires.
// The wires themselves are register.ts (the Electron and websocket
// bindings, broadcast, and the hub and direct plane's lifecycle). This
// file is what rides them: it builds each contract module's handler map
// from host/ipc/modules and ./modules, declares the layers of the two
// engines that need peer reach (the mirror daemon and the port
// forwards) bound to the same peer sessions the renderer uses, and
// registers the lot in registerIpcHandlers, which main/index.ts calls
// once at boot, after installing the runtime AppLive builds
// (main/runtime.ts).
import { join } from "node:path";
import {
  Cause,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Schedule,
  Schema,
} from "effect";
import { accountContract } from "@shared/ipc/modules/account";
import { branchesContract } from "@shared/ipc/modules/branches";
import { clientConfigContract } from "@shared/ipc/modules/clientConfig";
import { dialogContract } from "@shared/ipc/modules/dialog";
import { directContract } from "@shared/ipc/modules/direct";
import { forwardContract } from "@shared/ipc/modules/forward";
import { fsContract } from "@shared/ipc/modules/fs";
import { gitContract } from "@shared/ipc/modules/git";
import { githubCliContract } from "@shared/ipc/modules/githubCli";
import { globalConfigContract } from "@shared/ipc/modules/globalConfig";
import { hygieneContract } from "@shared/ipc/modules/hygiene";
import { launchersContract } from "@shared/ipc/modules/launchers";
import { menuContract } from "@shared/ipc/modules/menu";
import { coalesce } from "@host/lib/util/coalesce";
import {
  GitStateCoreSchema,
  MirrorEventSchema,
  MirrorWorktreePayloadSchema,
  mirrorContract,
} from "@shared/ipc/modules/mirror";
import { errorMessageOf } from "@shared/errors";
import { packageScriptsContract } from "@shared/ipc/modules/packageScripts";
import { portForwardContract } from "@shared/ipc/modules/portForward";
import { portPoolContract } from "@shared/ipc/modules/portPool";
import { portsContract } from "@shared/ipc/modules/ports";
import { projectsContract } from "@shared/ipc/modules/projects";
import { hubContract } from "@shared/ipc/modules/hub";
import { DeviceIdSchema } from "@shared/hub/protocol";
import { remoteAccessContract } from "@shared/ipc/modules/remoteAccess";
import { runtimeContract } from "@shared/ipc/modules/runtime";
import { scriptsContract } from "@shared/ipc/modules/scripts";
import { sharedSettingsContract } from "@shared/ipc/modules/sharedSettings";
import { cliContract } from "@shared/ipc/modules/cli";
import { controlContract } from "@shared/ipc/modules/control";
import { shellContract } from "@shared/ipc/modules/shell";
import { terrierContract } from "@shared/ipc/modules/terrier";
import { shigomoriContract } from "@shared/ipc/modules/shigomori";
import { syncContract } from "@shared/ipc/modules/sync";
import { updaterContract } from "@shared/ipc/modules/updater";
import { windowContract } from "@shared/ipc/modules/window";
import { worktreesContract } from "@shared/ipc/modules/worktrees";
import { branchesHandlers } from "@host/ipc/modules/branches";
import { clientConfigHandlers } from "./modules/clientConfig";
import { dialogHandlers } from "./modules/dialog";
import { forwardHandlers } from "@host/ipc/modules/forward";
import { fsHandlers } from "@host/ipc/modules/fs";
import { gitHandlers } from "@host/ipc/modules/git";
import { githubCliHandlers } from "@host/ipc/modules/githubCli";
import { globalConfigHandlers } from "@host/ipc/modules/globalConfig";
import { hygieneHandlers } from "@host/ipc/modules/hygiene";
import { launchersHandlers } from "@host/ipc/modules/launchers";
import { menuHandlers } from "./modules/menu";
import { currentMirrorList, mirrorHandlers } from "@host/ipc/modules/mirror";
import {
  endMirrorsWithPeers,
  isOrphanedTransfer,
  mirrorSessions,
} from "@host/mirror/registry";
import { packageScriptsHandlers } from "@host/ipc/modules/packageScripts";
import {
  PortForwardEngine,
  portForwardHandlers,
  stopPortForwardsTo,
} from "./modules/portForward";
import { portPoolHandlers } from "@host/ipc/modules/portPool";
import { portsHandlers } from "@host/ipc/modules/ports";
import { projectsHandlers } from "@host/ipc/modules/projects";
import { remoteAccessHandlers } from "@host/ipc/modules/remoteAccess";
import { runtimeHandlers } from "@host/ipc/modules/runtime";
import { scriptsHandlers } from "@host/ipc/modules/scripts";
import { sharedSettingsHandlers } from "@host/ipc/modules/sharedSettings";
import { sharedSettingsCopy } from "@host/lib/sharedSettings/store";
import { cliHandlers } from "@host/ipc/modules/cli";
import { controlHandlers } from "@host/ipc/modules/control";
import { shellHandlers } from "./modules/shell";
import { terrierHandlers } from "@host/ipc/modules/terrier";
import { shigomoriHandlers } from "@host/ipc/modules/shigomori";
import { syncHandlers } from "@host/ipc/modules/sync";
import { updaterHandlers } from "@host/ipc/modules/updater";
import { windowHandlers } from "./modules/window";
import { worktreesHandlers } from "@host/ipc/modules/worktrees";
import { buildClient } from "@shared/ipc/buildClient";
import { createPortForwardEngine } from "../core/portForward/engine";
import { createMirrorDaemon } from "../core/mirror/daemon";
import { createMirrorGateway } from "../core/mirror/gateway";
import { createMirrorHistory } from "../core/mirror/history";
import { createGitFollower } from "@host/mirror/gitFollow";
import {
  atomicWriteJsonSync,
  readJsonOrNullSync,
  withSchemaVersion,
} from "@host/lib/util/jsonFile";
import { safeDecodeWith } from "@shared/ipc/codec";
import { ProjectScopedPayloadSchema } from "@shared/schemas/payloads";
import { spawnFileSync } from "@host/fileSync/spawn";
import { dataDir } from "@host/lib/util/paths";
import { accountSignedIn, makeAccountHandlers } from "./modules/account";
import { reconcileLaunchAtLogin } from "../electron/liveness";
import { withoutPeerState } from "@shared/schemas/config";
import {
  readClientConfigSync,
  writeClientConfig,
} from "../electron/clientConfig";
import {
  broadcastAll,
  clearDirectTickets,
  DirectPlane,
  directHandlers,
  refreshHubConnection,
  registerContract,
  registerControlContract,
  hubHandlers,
  onPeerPush,
} from "./register";
import { hostRuntime, hostService } from "@host/runtime";
import { runner } from "../services";

// The pull/transplant orchestrations' and the port-forward engine's
// peer reach, routed through the SAME invokePeer path (and so the same
// cached direct peer session) the renderer's remote-device api uses.
// Opening a second session directly would supersede-kill the one every
// remote-forest query is riding, since the host keeps one authed
// socket per device. Built off the plane a layer depends on, so the
// layer releases before the plane does.
export const peerTransportVia =
  (plane: DirectPlane["Service"]) => (deviceId: string) => ({
    // The handler is called directly, past the registrar's input wall,
    // so the id is held to the wire's shape here instead.
    invoke: (channel: string, input: unknown) =>
      Promise.resolve().then(() =>
        plane.handlers.invokePeer(
          { deviceId: DeviceIdSchema.make(deviceId), channel, input },
          undefined,
        ),
      ),
    subscribe: (): (() => void) => {
      throw new Error("the peer api is invoke-only");
    },
  });

// A gateway that fails to bind (a loopback oddity) is retried on a
// slow schedule rather than given up on: the daemon starts regardless
// and its own restart ladder picks the address up once bound.
const GATEWAY_RETRY_MS = 30_000;

// Continuous worktree mirroring, this device's half: the loopback
// gateway the daemon dials peers through and the daemon itself
// (main/core/mirror/*, both electron-free), bound here to the peer sessions
// and to the renderer's changed signal exactly like the port-forward
// engine. The gateway binds as its layer is built, retrying inside the
// layer's scope, so the retry dies with the runtime instead of running
// on an untracked timer; the daemon starts from main/index.ts once
// that first attempt settled, and both stop when the runtime is
// disposed. A boot without the engine binary (a dev run before
// file-sync:build) reports "unavailable" and keeps retrying.
export class MirrorGateway extends Context.Service<
  MirrorGateway,
  {
    gateway: ReturnType<typeof createMirrorGateway>;
    // Settles once the first bind attempt did, however it went.
    firstBind: Effect.Effect<void>;
    // The gateway down and its retry with it (stopMirrorEngine).
    stop: () => void;
  }
>()("sm/main/MirrorGateway") {
  static readonly layer = Layer.effect(
    MirrorGateway,
    Effect.gen(function* () {
      const plane = yield* DirectPlane;
      const peerTransportFor = peerTransportVia(plane);
      const gateway = yield* runner(
        "the mirror gateway",
        () =>
          createMirrorGateway({
            peerApiFor: (deviceId) =>
              buildClient(mirrorContract, peerTransportFor(deviceId)),
            peerChannelsFor: (deviceId) => () =>
              plane.handlers.peerChannels(deviceId),
          }),
        (bound) => bound.stop(),
      );
      const tried = yield* Deferred.make<void>();
      const binding = yield* Effect.tryPromise({
        try: () => gateway.start(),
        catch: (error) => error,
      }).pipe(
        Effect.tapError((error) =>
          Effect.sync(() =>
            console.warn(
              "[mirror] gateway failed to bind, retrying:",
              errorMessageOf(error),
            ),
          ),
        ),
        // Settled on an attempt's own outcome, bound or not. An
        // interrupt (a stop during the first bind) settles nothing, so a
        // start still waiting on it never starts the daemon after the
        // stop that ended the gateway.
        Effect.onExit((exit) =>
          Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)
            ? Effect.void
            : Deferred.succeed(tried, undefined),
        ),
        Effect.retry(Schedule.spaced(GATEWAY_RETRY_MS)),
        Effect.forkScoped,
      );
      return {
        gateway,
        firstBind: Deferred.await(tried),
        stop: () => {
          Effect.runFork(Fiber.interrupt(binding));
          gateway.stop();
        },
      };
    }),
  );
}

// The daemon snapshots on every cycle of every session and the
// follower reports every verdict. The renderer's ping is coalesced so
// a busy mirror costs viewers one refetch per beat, not one per cycle.
export const broadcastMirrorChanged = coalesce(() => {
  // Off a timer, so a throw here is the main process's uncaught
  // exception. The list is validated against its strict schema on the
  // way out, and one that fails it goes out as the bare signal (a
  // reader then asks), as it did before the broadcast carried a list.
  try {
    broadcastAll(mirrorContract, "changed", currentMirrorList());
  } catch (error) {
    console.warn(
      `[mirror] the changed broadcast goes without its list: ${errorMessageOf(error)}`,
    );
    broadcastAll(mirrorContract, "changed", undefined);
  }
}, 150);
const fileSyncDir = () => join(dataDir(), "file-sync");
// The git follower's agreed states, one file beside the engine's data.
const gitFollowStorePath = () => join(fileSyncDir(), "git-follow.json");
const GitFollowStoreSchema = Schema.Struct({
  agreed: Schema.Record(Schema.String, GitStateCoreSchema).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
});
// The mirrors' event threads (main/core/mirror/history.ts), one file
// beside the follower's, fed by every daemon snapshot and follower
// verdict below and by the handlers' control ops.
const mirrorHistoryPath = () => join(fileSyncDir(), "mirror-history.json");
const MirrorHistoryStoreSchema = Schema.Struct({
  events: Schema.Record(
    Schema.String,
    Schema.mutable(Schema.Array(MirrorEventSchema)),
  ).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
});
// The engine persists its sessions, so they come back on every spawn:
// a boot that starts signed out, or a daemon that was down at the
// sign-out, would otherwise resume mirroring with peers of an account
// this device is not on. Each session is asked once (the
// reapOrphanedTransfers idiom). The account fan-out's own sweep
// covers the daemon-was-up case.
const LEFT_ACCOUNT_DETAIL =
  "This device left the account. The copy stays as a worktree.";

export class MirrorDaemon extends Context.Service<
  MirrorDaemon,
  ReturnType<typeof createMirrorDaemon>
>()("sm/main/MirrorDaemon") {}

export class MirrorHistory extends Context.Service<
  MirrorHistory,
  ReturnType<typeof createMirrorHistory>
>()("sm/main/MirrorHistory") {}

export class GitFollower extends Context.Service<
  GitFollower,
  ReturnType<typeof createGitFollower>
>()("sm/main/GitFollower") {}

// The daemon, its event threads and the git follower read one another
// (the daemon's snapshots feed the follower and the history, the
// follower lists the daemon's sessions, the history asks the follower
// for each session's verdict), so the three are built in ONE layer
// effect through the lazy references the factories already take,
// rather than as layers a Layer.provide could order. Acquired history,
// daemon, follower: on quit the follower stops first, then the daemon
// (its stdin closed, reaped with the CLI children if it lingers), then
// the gateway it dials through, whose layer this one depends on.
export const MirrorEngineLive = Layer.effectContext(
  Effect.gen(function* () {
    const { gateway: mirrorGateway } = yield* MirrorGateway;
    const plane = yield* DirectPlane;
    const peerTransportFor = peerTransportVia(plane);
    const mirrorHistory = createMirrorHistory({
      store: {
        load: () =>
          readJsonOrNullSync(mirrorHistoryPath(), MirrorHistoryStoreSchema)
            ?.events ?? {},
        save: (events) =>
          atomicWriteJsonSync(
            mirrorHistoryPath(),
            withSchemaVersion({ events }),
          ),
      },
      onChange: () => broadcastMirrorChanged(),
    });
    // The daemon's sessions that are mirrors: a transplant's one-shot file
    // transfer rides the same daemon under a label (host/mirror/oneShot.ts),
    // and neither the follower nor the history should treat it as one.
    const liveMirrorSessions = () => mirrorSessions(mirrorDaemon);
    // A transfer session no pull here is waiting on (registry.ts
    // isOrphanedTransfer: left by a quit or a crash mid-transfer, a
    // rejected create, a failed terminate). No mirror surface would ever
    // show it, so it is ended on sight. Each is asked once, and the engine drops it
    // from the next snapshot.
    const reaped = new Set<string>();
    const reapOrphanedTransfers = () => {
      for (const session of mirrorDaemon.sessions()) {
        if (!isOrphanedTransfer(session) || reaped.has(session.session)) {
          continue;
        }
        reaped.add(session.session);
        void mirrorDaemon.terminate(session.session).catch((error: unknown) => {
          console.warn(
            `[mirror] could not end an orphaned transfer session: ${errorMessageOf(error)}`,
          );
        });
      }
    };
    const observeMirrorHistory = () =>
      mirrorHistory.observe(liveMirrorSessions(), (session) =>
        gitFollower.statusOf(session),
      );
    const sweptSessions = new Set<string>();
    const endMirrorsOfNoAccount = (): void => {
      if (mirrorDaemon.status() !== "running") return;
      const unswept = mirrorDaemon
        .sessions()
        .filter((raw) => !sweptSessions.has(raw.session));
      // The sign-in check opens the credential (a keychain read), so it
      // runs only when there is something new to ask about.
      if (unswept.length === 0 || accountSignedIn()) return;
      for (const raw of unswept) sweptSessions.add(raw.session);
      void endMirrorsWithPeers(() => false, LEFT_ACCOUNT_DETAIL, {
        transfers: true,
      });
    };
    const mirrorDaemon = yield* runner(
      "the mirror daemon",
      () =>
        createMirrorDaemon({
          spawn: spawnFileSync,
          dataDir: fileSyncDir,
          gatewayAddress: () => {
            const address = mirrorGateway.address();
            if (address === null) {
              throw new Error("mirror gateway is not listening");
            }
            return address;
          },
          gatewayToken: () => {
            const token = mirrorGateway.token();
            if (token === null) {
              throw new Error("mirror gateway is not listening");
            }
            return token;
          },
          onChange: () => {
            broadcastMirrorChanged();
            // The follower compares the session set itself. A snapshot that
            // only moved a cycle count is a no-op there.
            gitFollower.sessionsChanged();
            observeMirrorHistory();
            reapOrphanedTransfers();
            endMirrorsOfNoAccount();
          },
        }),
      (daemon) => daemon.stop(),
    );
    // The git half of every session this device runs (host/mirror/
    // gitFollow.ts): reads the daemon's sessions, reaches the peer through
    // the same cached direct sessions, and reports through the same
    // changed signal. Its inputs are wired in registerIpcHandlers and
    // main/index.ts: the local git watcher (via notifyLocalProjectChanged),
    // the peers' pushes (onPeerPush) and the daemon's snapshots (above).
    const gitFollower = yield* runner(
      "the git follower",
      () =>
        createGitFollower({
          sessions: liveMirrorSessions,
          peerSyncApiFor: (deviceId) =>
            buildClient(syncContract, peerTransportFor(deviceId)),
          peerMirrorApiFor: (deviceId) =>
            buildClient(mirrorContract, peerTransportFor(deviceId)),
          // The states both sides last agreed on, beside the engine's own
          // data so a restart resumes the follow rule rather than falling
          // back to ancestry.
          agreedStore: {
            load: () =>
              readJsonOrNullSync(gitFollowStorePath(), GitFollowStoreSchema)
                ?.agreed ?? {},
            save: (agreed) =>
              atomicWriteJsonSync(
                gitFollowStorePath(),
                withSchemaVersion({ agreed }),
              ),
          },
          onChange: () => {
            broadcastMirrorChanged();
            observeMirrorHistory();
          },
        }),
      (follower) => follower.stop(),
    );
    return Context.make(MirrorHistory, mirrorHistory).pipe(
      Context.add(MirrorDaemon, mirrorDaemon),
      Context.add(GitFollower, gitFollower),
    );
  }),
);

// The mirror sweep of a device leaving its account, bounded so a stuck
// daemon request cannot hold the sign-out: the hub refresh that
// follows closes the sessions the sweep's terminates ride. Past the
// bound the sign-out stops waiting (the timer is the fiber's, gone with
// it); the terminates already sent are the daemon's to answer.
function endAllMirrorsBounded(): Promise<unknown> {
  return hostRuntime().runPromise(
    Effect.promise(() =>
      endMirrorsWithPeers(() => false, LEFT_ACCOUNT_DETAIL, {
        transfers: true,
      }),
    ).pipe(Effect.timeoutOption("5 seconds")),
  );
}

// A step of the account fan-out that must not take the rest with it.
async function teardownStep(what: string, run: () => unknown): Promise<void> {
  try {
    await run();
  } catch (error) {
    console.warn(`[account] ${what} failed: ${errorMessageOf(error)}`);
  }
}

export function notifyLocalProjectChanged(projectId: string): void {
  hostService(GitFollower).onLocalProjectChanged(projectId);
}

// "This project's git state moved on this machine": the project-scoped
// ping on every wire (this window and every device viewing this host
// refetch that project's rows), and the mirror's git follower
// re-looking at every session in the project (a commit or checkout
// here must reach the peer). Sent by the git-directory watcher for
// every external ref move, and by the app-run git commands the watcher
// skips as the app's own when no renderer caller invalidates for them.
export function announceProjectChanged(projectId: string): void {
  broadcastAll(gitContract, "projectChanged", { projectId });
  notifyLocalProjectChanged(projectId);
}

// The daemon starts once the gateway's first bind attempt settled,
// bound or not (a failed bind keeps retrying in the gateway's layer).
export async function startMirrorEngine(): Promise<void> {
  const { firstBind } = hostService(MirrorGateway);
  await Effect.runPromise(firstBind);
  hostService(MirrorDaemon).start();
  hostService(GitFollower).start();
}

// The quit path gets the same stops, in the same order, from the
// layers' finalizers when main/index.ts disposes the runtime.
export function stopMirrorEngine(): void {
  hostService(GitFollower).stop();
  hostService(MirrorDaemon).stop();
  hostService(MirrorGateway).stop();
}

// The account handlers, one instance for the account contract and the
// control ops' device listing (ControlReach), so the membership sweep
// below hears every registry list either one reads. A layer of its
// own with no finalizer: the callbacks reach the runners through the
// runtime at call time.
export class AccountHandlers extends Context.Service<
  AccountHandlers,
  ReturnType<typeof makeAccountHandlers>
>()("sm/main/AccountHandlers") {
  static readonly layer = Layer.sync(AccountHandlers, () => {
    // The account the peer-facing state was built under, so a change
    // can tell a rename (same account, nothing to tear down) from a
    // sign-out. Unknown until the first change: reading it here would
    // open the credential store before app.ready, where safeStorage
    // still reports encryption unavailable on Windows and Linux and the
    // cipher it builds would write plaintext for the whole session. An
    // unknown previous account leaves only one thing certain: a change
    // to signed out is a departure.
    let peerAccountId: string | null | undefined;
    let lastMembership = new Set<string>();
    // Client-scoped: sign-in drives the OS browser and writes an
    // OS-keychain credential on this machine, so it never rides the socket
    // wire. The changed broadcast fans out to every window after any
    // sign-in, sign-out or rename, and the hub socket re-reconciles
    // against the fresh account state at the same moment. A departure
    // (a sign-out, since the hub refuses a switch without one) tears
    // down what was the account's, in an order the pieces need: the
    // mirror sweep and the config write before the windows are told
    // (the sweep's terminates ride the sessions the hub refresh closes;
    // the windows re-read their config off the broadcast), the shared
    // settings after the refresh (a peer's push landing between the
    // clear and the sessions closing would refill the copy). Every step
    // is fenced so one failing cannot leave the remote plane up.
    return makeAccountHandlers(
      async (accountId) => {
        const previous = peerAccountId;
        peerAccountId = accountId;
        const leaving =
          previous === undefined
            ? accountId === null
            : previous !== null && accountId !== previous;
        if (leaving) {
          clearDirectTickets();
          stopPortForwardsTo(() => false);
          await teardownStep("the mirror sweep", endAllMirrorsBounded);
          await teardownStep("dropping the peer-keyed client config", () =>
            writeClientConfig(withoutPeerState(readClientConfigSync())),
          );
        }
        broadcastAll(accountContract, "changed", { accountId });
        // A direct account switch that stays signed in changes the
        // command-access answer, so refresh the renderer's switch query
        // too. Main's grant cache is already invalidated in
        // makeAccountHandlers, so enforcement is correct without this.
        // This only keeps the renderer display fresh, since `changed`
        // invalidates the ["account"] prefix but not
        // ["accountCommandAccess"].
        broadcastAll(accountContract, "commandAccessChanged", undefined);
        broadcastAll(remoteAccessContract, "commandAccessChanged", undefined);
        // Also reconciles the direct listener from its tail, which
        // follows the same enrollment condition.
        await refreshHubConnection();
        if (leaving) {
          await teardownStep("dropping the shared settings", () =>
            sharedSettingsCopy.clear(),
          );
          // The login item keeps a machine reachable TO its account;
          // signed out it comes off, and the next sign-in puts it back.
          reconcileLaunchAtLogin();
        } else if (previous === null || previous === undefined) {
          reconcileLaunchAtLogin();
        }
      },
      // The switch flipping fans out on its own channel so the toggle
      // does not thrash the account status and device queries. No hub
      // reconnect: the listener reads the predicate live. The peers
      // hear it too (remote:true), so their verdict refreshes at once.
      () => {
        broadcastAll(accountContract, "commandAccessChanged", undefined);
        broadcastAll(remoteAccessContract, "commandAccessChanged", undefined);
      },
      // The registry as the hub last reported it is the one place this
      // device learns a peer was removed from the account (the hub
      // pushes no such thing, and an absent peer looks like an offline
      // one on the roster). A mirror with a device no longer on the
      // account ends here, the other half of the sign-out rule above.
      (devices) => {
        // Only a membership change sweeps: the list is read on every
        // window focus, and the sweeps walk every session and forward.
        const onAccount = new Set(devices.map((device) => device.deviceId));
        const same =
          onAccount.size === lastMembership.size &&
          [...onAccount].every((id) => lastMembership.has(id));
        if (same) return;
        lastMembership = onAccount;
        const stillOn = (deviceId: string) => onAccount.has(deviceId);
        void endMirrorsWithPeers(
          stillOn,
          "The other device left the account. The copy stays as a worktree.",
          { transfers: true },
        );
        // A forward is standing intent across a peer being asleep, so
        // it follows the account's membership, never the roster.
        stopPortForwardsTo(stillOn);
      },
    );
  });
}

// The port-forward engine's peer reach, riding the same
// peerTransportVia as the sync wiring and for the same reason:
// a second session would supersede the one the renderer's
// remote-forest queries ride. The engine itself is electron-free
// (main/core/portForward/engine.ts), and this is its only binding to the
// peer sessions and to the renderer's changed signal. It depends on the
// direct plane, so on quit its forwards stop (their close frames riding
// the peer sessions) before the plane and the hub socket go.
export const PortForwardEngineLive = Layer.effect(
  PortForwardEngine,
  Effect.gen(function* () {
    const plane = yield* DirectPlane;
    const peerTransportFor = peerTransportVia(plane);
    return yield* runner(
      "the port forwards",
      () =>
        createPortForwardEngine({
          forwardApiFor: (deviceId) =>
            buildClient(forwardContract, peerTransportFor(deviceId)),
          // The byte channels of the same cached direct session.
          channelsFor: (deviceId) => () =>
            plane.handlers.peerChannels(deviceId),
          onChange: () => {
            broadcastAll(portForwardContract, "changed", undefined);
          },
        }),
      (engine) => engine.stopAll(),
    );
  }),
);

export function registerIpcHandlers(): void {
  registerContract(clientConfigContract, clientConfigHandlers);
  // The account fan-out lives with the handlers' layer (AccountHandlers
  // above).
  registerContract(accountContract, hostService(AccountHandlers));
  // Client-scoped bridge onto the main-process hub socket: status,
  // invokes over the keeper-held direct sessions, and the
  // peerPush/statusChanged fan-outs. The
  // handlers themselves are constructed in register.ts, which owns
  // every dep and folds directPeerVersions back into the status
  // snapshot.
  registerContract(hubContract, hubHandlers());
  // The direct data plane's brokering surface: host-scoped and
  // remote:true, so a peer asks over the device hub (or an existing
  // direct session) how to dial this host directly. The handlers are
  // constructed in register.ts, which owns every dep (the listener, the
  // ticket store, the hub roster). The handler fails closed without an
  // authenticated callerDeviceId, so the Electron wire always reads
  // available:false.
  registerContract(directContract, directHandlers());
  // The sync orchestrations' peer reach (host/ipc/peerSync.ts) and the
  // port-forward engine ride peerTransportVia above, provided as
  // services (main/electron/hostImpls.ts, PortForwardEngineLive).
  // Client-scoped like dialog: the listeners belong to the machine the
  // window runs on, so the surface never mounts on a remote wire.
  registerContract(portForwardContract, portForwardHandlers);
  // The mirror surface: host-scoped (a device's mirrors are its facts,
  // and peers read the list), its daemon provided as MirrorEngine
  // (main/electron/hostImpls.ts). The serving set (streams this host
  // serves for peers) fans out on the same changed signal.
  // The follower's peer-side signals: a peer's git state moved (its
  // git-directory watcher) or a served worktree's index did.
  const gitFollower = hostService(GitFollower);
  onPeerPush((push) => {
    if (push.channel === "git:projectChanged") {
      const parsed = safeDecodeWith(ProjectScopedPayloadSchema, push.payload);
      if (parsed.success) {
        gitFollower.onPeerProjectChanged(push.deviceId, parsed.data.projectId);
      }
    } else if (push.channel === "mirror:gitChanged") {
      const parsed = safeDecodeWith(MirrorWorktreePayloadSchema, push.payload);
      if (parsed.success) {
        gitFollower.onPeerWorktreeChanged(
          push.deviceId,
          parsed.data.projectId,
          parsed.data.worktreeId,
        );
      }
    }
  });
  registerContract(mirrorContract, mirrorHandlers);
  registerContract(windowContract, windowHandlers);
  // Host-scoped preflight for the remote execution surface: each wire's
  // binding supplies the calling peer's grant verdict on the context.
  registerContract(remoteAccessContract, remoteAccessHandlers);
  registerContract(projectsContract, projectsHandlers);
  registerContract(dialogContract, dialogHandlers);
  registerContract(runtimeContract, runtimeHandlers);
  registerContract(shellContract, shellHandlers);
  registerContract(branchesContract, branchesHandlers);
  registerContract(globalConfigContract, globalConfigHandlers);
  registerContract(portPoolContract, portPoolHandlers);
  registerContract(portsContract, portsHandlers);
  registerContract(terrierContract, terrierHandlers);
  registerContract(menuContract, menuHandlers);
  registerContract(launchersContract, launchersHandlers);
  registerContract(packageScriptsContract, packageScriptsHandlers);
  registerContract(fsContract, fsHandlers);
  registerContract(gitContract, gitHandlers);
  registerContract(githubCliContract, githubCliHandlers);
  registerContract(worktreesContract, worktreesHandlers);
  registerContract(hygieneContract, hygieneHandlers);
  registerContract(scriptsContract, scriptsHandlers);
  registerContract(sharedSettingsContract, sharedSettingsHandlers);
  registerContract(cliContract, cliHandlers);
  // The CLI's cross-device verbs, on the control wire alone
  // (shared/ipc/modules/control.ts). The device registry rides the
  // stored credential and the peer reach is peerTransportVia above,
  // the one cached session per peer everything else rides; both are
  // provided as ControlReach (main/electron/hostImpls.ts).
  registerControlContract(controlContract, controlHandlers);
  registerContract(shigomoriContract, shigomoriHandlers);
  registerContract(syncContract, syncHandlers);
  // Host side of the port-forward wire: host-scoped, so it mounts on
  // the Electron wire and both remote wires, where the grant model
  // gates every verb (all mutating:true).
  registerContract(forwardContract, forwardHandlers);
  // Host-scoped: a peer's Settings page reads this device's update
  // state and, when granted, checks or restarts into an update here.
  registerContract(updaterContract, updaterHandlers);
}
