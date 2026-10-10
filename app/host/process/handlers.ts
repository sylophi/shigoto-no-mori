// Every handler the host serves, assembled and put on the wires. The
// wires themselves are wires.ts (the loopback, the device link, and the
// hub and direct plane's lifecycle). This file is what rides them: it
// builds each host-side module's handler map from host/ipc/modules,
// binds the two engines that need peer reach (the mirror daemon and the
// port forwards) to the same peer sessions the windows use, and
// registers the lot in registerHostHandlers, once at start. The
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
import type { HubHandlers } from "@shared/hub/bridgeHandlers";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { coalesce } from "@host/lib/util/coalesce";
import {
  GitStateCoreSchema,
  MirrorEventSchema,
  MirrorWorktreePayloadSchema,
  mirrorContract,
} from "@shigomori/contracts/modules/mirror";
import {
  callFailureOf,
  errorMessageOf,
  isEntityGoneError,
} from "@shigomori/contracts/errors";
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
import { githubCliHandlers } from "@host/ipc/modules/githubCli";
import {
  globalConfigHandlers,
  globalConfigViews,
} from "@host/ipc/modules/globalConfig";
import { hygieneHandlers } from "@host/ipc/modules/hygiene";
import { launchersHandlers } from "@host/ipc/modules/launchers";
import { mirrorHandlers, mirrorViews } from "@host/ipc/modules/mirror";
import {
  setMirrorGitAppliedListener,
  setMirrorGitChangedListener,
  setMirrorServingListener,
} from "@host/mirror/serving";
import { currentMirrorList, endMirrorIfCopyGone } from "@host/mirror/sessions";
import {
  createNoAccountSweep,
  endMirrorsOnPeerRemoval,
  endMirrorsWithPeers,
  settleMirrorBookkeeping,
  whileRecreating,
  isOrphanedTransfer,
  mirrorSessions,
  setMirrorImpl,
  MirrorError,
  type MirrorImpl,
  type MirrorSessionRaw,
} from "@host/mirror/registry";
import {
  MirrorInviteSchema,
  reconcileMirrorInvites,
  setMirrorInviteStore,
} from "@host/mirror/invites";
import { findProjectAndWorktree } from "@host/lib/projects";
import { onRunningScriptsChanged } from "@host/lib/scripts";
import { packageScriptsHandlers } from "@host/ipc/modules/packageScripts";
import {
  portForwardHandlers,
  setPortForwardEngine,
  stopPortForwardsTo,
} from "@host/ipc/modules/portForward";
import { portPoolHandlers } from "@host/ipc/modules/portPool";
import { portsHandlers, portsViews } from "@host/ipc/modules/ports";
import { projectsHandlers, projectsViews } from "@host/ipc/modules/projects";
import { runtimeHandlers } from "@host/ipc/modules/runtime";
import { scriptsHandlers, scriptsViews } from "@host/ipc/modules/scripts";
import {
  sharedSettingsHandlers,
  sharedSettingsViews,
} from "@host/ipc/modules/sharedSettings";
import { sharedSettingsCopy } from "@host/lib/sharedSettings/store";
import { cliHandlers } from "@host/ipc/modules/cli";
import { sharingHandlers, sharingViews } from "@host/ipc/modules/sharing";
import { terminalsHandlers, terminalsViews } from "@host/ipc/modules/terminals";
import { controlHandlers, controlTransfers } from "@host/ipc/modules/control";
import { setControlImpl } from "@host/lib/control/peers";
import { terrierHandlers } from "@host/ipc/modules/terrier";
import { agentsHandlers } from "@host/ipc/modules/agents";
import { shigomoriHandlers } from "@host/ipc/modules/shigomori";
import { worktreeDataHandlers } from "@host/ipc/modules/worktreeData";
import { syncHandlers } from "@host/ipc/modules/sync";
import { updaterHandlers } from "@host/ipc/modules/updater";
import { villagersHandlers } from "@host/ipc/modules/villagers";
import {
  setWorktreeRemovalBroadcaster,
  worktreesHandlers,
  worktreesViews,
} from "@host/ipc/modules/worktrees";
import type { ClientTransport } from "@shared/ipc/transport";
import { peerClient, setPeerReach } from "@host/ipc/peerSync";
import { createPortForwardEngine } from "@host/portForward/engine";
import * as MirrorDaemon from "@host/mirror/daemon";
import { createMirrorGateway } from "@host/mirror/gateway";
import { createMirrorHistory } from "@host/mirror/history";
import { type GitFollower, makeGitFollower } from "@host/mirror/gitFollow";
import {
  atomicWriteJsonSync,
  readJsonOrNullSync,
} from "@host/lib/util/atomicJson";
import { ProjectScopedPayloadSchema } from "@shigomori/contracts/schemas/payloads";
import { dataDir } from "@host/lib/util/paths";
import { getDeviceId } from "@host/lib/config/deviceId";
import {
  type AccountFacts,
  acceptsPeerCommands,
  accountSignedIn,
  hubConnectInputs,
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
import { log, logFailure } from "@shared/log";
import { layerLatch } from "@host/lib/util/layerLatch";
import * as Captures from "./captures";

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

// The byte channels of the same session.
const peerChannelsFor = (deviceId: string) => () =>
  hubHandlers().peerChannels(deviceId);

// Continuous worktree mirroring, this device's half: the loopback
// gateway the daemon dials peers through and the daemon itself
// (host/mirror/daemon.ts, gateway.ts), bound here to the peer sessions
// and to the renderer's changed signal exactly like the port-forward
// engine. Started and stopped by the host's layer graph
// (layer.ts). A boot without the engine binary (a dev run
// before file-sync:build) reports "unavailable" and keeps retrying.
const mirrorGateway = createMirrorGateway({
  peerApiFor: (deviceId) => peerClient(mirrorContract, deviceId),
  peerChannelsFor,
});
// The daemon snapshots on every cycle of every session and the
// follower reports every verdict. The renderer's ping is coalesced so
// a busy mirror costs viewers one refetch per beat, not one per cycle.
const broadcastMirrorChanged = coalesce(() => {
  void Captures.onEngine(currentMirrorList).then(
    (list) => {
      // The list is validated against its strict schema on the way
      // out, and one that fails it goes out as the bare signal (a
      // reader then asks), as it did before the broadcast carried a list.
      try {
        broadcastAll(mirrorContract, "changed", list);
      } catch (error) {
        log.warn(
          `[mirror] the changed broadcast goes without its list: ${errorMessageOf(error)}`,
        );
        broadcastAll(mirrorContract, "changed", undefined);
      }
    },
    () => {},
  );
}, 150);
const fileSyncDir = () => join(dataDir(), "file-sync");
// The git follower's agreed states, one file beside the engine's data.
const gitFollowStorePath = () => join(fileSyncDir(), "git-follow.json");
const GitFollowStoreSchema = Schema.Struct({
  agreed: Schema.Record(Schema.String, GitStateCoreSchema).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
});
// The mirrors' event threads (host/mirror/history.ts), one file
// beside the follower's, fed by every daemon snapshot and follower
// verdict below and by the handlers' control ops.
const mirrorHistoryPath = () => join(fileSyncDir(), "mirror-history.json");
const MirrorHistoryStoreSchema = Schema.Struct({
  events: Schema.Record(Schema.String, Schema.Array(MirrorEventSchema)).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
});
// The mirrors this device invited (host/mirror/invites.ts), beside them.
const mirrorInvitesPath = () => join(fileSyncDir(), "mirror-invites.json");
const decodeMirrorWorktreePayload = Schema.decodeUnknownOption(
  MirrorWorktreePayloadSchema,
);
const MirrorInviteStoreSchema = Schema.Struct({
  invites: Schema.Array(MirrorInviteSchema).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
});
const mirrorHistory = createMirrorHistory({
  store: {
    load: () =>
      readJsonOrNullSync(mirrorHistoryPath(), MirrorHistoryStoreSchema)
        ?.events ?? {},
    save: (events) => atomicWriteJsonSync(mirrorHistoryPath(), { events }),
  },
  onChange: () => broadcastMirrorChanged(),
});
// The daemon and the git follower the mirror impl below runs on, once
// the mirror layer is up (mirrorLayer). A call before then waits for
// it.
const mirror = layerLatch<{
  readonly daemon: MirrorDaemon.MirrorDaemon["Service"];
  readonly follower: GitFollower;
}>("The mirror engine");
const onDaemon = <A>(
  f: (
    daemon: MirrorDaemon.MirrorDaemon["Service"],
  ) => Effect.Effect<A, MirrorDaemon.MirrorDaemonError>,
): Effect.Effect<A, MirrorError> =>
  mirror.get.pipe(
    Effect.flatMap(({ daemon }) => f(daemon)),
    Effect.mapError((error) => new MirrorError({ reason: error.message })),
  );
// An engine that failed to start lists nothing.
const daemonSessions = mirror.get.pipe(
  Effect.flatMap(({ daemon }) => daemon.sessions),
  Effect.orElseSucceed((): readonly MirrorSessionRaw[] => []),
);

// The mirror surface's impl (host/mirror/registry.ts MirrorImpl).
const mirrorImpl: MirrorImpl = {
  status: mirror.get.pipe(
    Effect.flatMap(({ daemon }) => daemon.status),
    Effect.orElseSucceed(() => "unavailable" as const),
  ),
  sessions: daemonSessions,
  // A start's long leg (the copy across) can straddle a sign-out; the
  // sweep that ran meanwhile found nothing, so this is the last gate
  // before a session with a peer of no account.
  create: (input) =>
    hubConnectInputs() === null
      ? Effect.fail(
          new MirrorError({
            reason: "This device is signed out, so it cannot mirror.",
          }),
        )
      : onDaemon((daemon) => daemon.create(input)),
  // The old session is paused, not ended, until the new one is up: two
  // running sessions on one root would fight, but a paused one holds
  // nothing, and a create that fails (peer away) then leaves the
  // mirror as it was instead of gone with no way to re-open it. The
  // agreement moves to the new id, so the follower picks up where it
  // was instead of starting from the no-agreement fallback. Held as
  // recreating throughout, so the leftover sweep (registry.ts
  // settleMirrorBookkeeping) does not end the old session under it. An
  // old session already gone by the terminate was ended all the same.
  recreate: (session, input) =>
    whileRecreating(
      session,
      Effect.gen(function* () {
        yield* onDaemon((daemon) => daemon.pause(session));
        const next = yield* mirrorImpl
          .create(input)
          .pipe(
            Effect.tapError(() =>
              Effect.ignore(onDaemon((daemon) => daemon.resume(session))),
            ),
          );
        yield* onDaemon((daemon) => daemon.terminate(session)).pipe(
          Effect.catch((error) =>
            Effect.flatMap(daemonSessions, (sessions) =>
              sessions.some((raw) => raw.session === session)
                ? Effect.fail(error)
                : Effect.void,
            ),
          ),
        );
        mirror.now()?.follower.rename(session, next);
        return next;
      }),
    ),
  // An explicit stop ends the agreement too, or the git follower's
  // store keeps one entry per session ever created. A terminate that
  // failed still ends it: the session is doomed either way, and the
  // entry would otherwise outlive the daemon that could ever match it.
  terminate: (session) =>
    onDaemon((daemon) => daemon.terminate(session)).pipe(
      Effect.asVoid,
      Effect.ensuring(
        Effect.sync(() => mirror.now()?.follower.forget(session)),
      ),
    ),
  pause: (session) =>
    Effect.asVoid(onDaemon((daemon) => daemon.pause(session))),
  resume: (session) =>
    Effect.asVoid(onDaemon((daemon) => daemon.resume(session))),
  gitStatus: (session) => mirror.now()?.follower.statusOf(session),
  refreshGit: (session) =>
    mirror.get.pipe(
      Effect.flatMap(({ follower }) => follower.reconcileNow(session)),
      Effect.orElseSucceed(() => undefined),
    ),
  history: (localWorktreeId) => mirrorHistory.eventsFor(localWorktreeId),
  noteEvent: (localWorktreeId, kind, detail) =>
    mirrorHistory.note(localWorktreeId, kind, detail),
  forgetHistory: (localWorktreeId) => mirrorHistory.forget(localWorktreeId),
  moveHistory: (from, to) => mirrorHistory.move(from, to),
};

// A transfer session no pull here is waiting on (registry.ts
// isOrphanedTransfer: left by a quit or a crash mid-transfer, a
// rejected create, a failed terminate). No mirror surface would ever
// show it, so it is ended on sight. Each is asked once, and the engine
// drops it from the next snapshot.
const reaped = new Set<string>();
const reapOrphanedTransfers = Effect.flatMap(daemonSessions, (sessions) =>
  Effect.forEach(
    sessions.filter(
      (session) => isOrphanedTransfer(session) && !reaped.has(session.session),
    ),
    (session) => {
      reaped.add(session.session);
      return mirrorImpl
        .terminate(session.session)
        .pipe(
          Effect.catch((error) =>
            Effect.sync(() =>
              log.warn(
                `[mirror] could not end an orphaned transfer session: ${error.message}`,
              ),
            ),
          ),
        );
    },
    { discard: true },
  ),
);
// The daemon's sessions that are mirrors, into their threads.
const observeMirrorHistory = Effect.map(
  mirrorSessions(mirrorImpl),
  (sessions) =>
    mirrorHistory.observe(sessions, (session) =>
      mirror.now()?.follower.statusOf(session),
    ),
);
// The gateway's facts the daemon is handed, once it has them.
function listening<T>(value: T | null): T {
  if (value === null) throw new Error("mirror gateway is not listening");
  return value;
}

export const mirrorDaemonLayer = MirrorDaemon.layer({
  dataDir: fileSyncDir,
  gatewayAddress: () => listening(mirrorGateway.address()),
  gatewayToken: () => listening(mirrorGateway.token()),
  onChange: () => {
    broadcastMirrorChanged();
    // The follower compares the session set itself. A snapshot that
    // only moved a cycle count is a no-op there.
    mirror.now()?.follower.sessionsChanged();
    noAccountSweep.run();
    // The history, the orphaned transfers, and the stops that waited
    // for the daemon, originals gone behind the app's back, sessions a
    // re-open replaced (registry.ts).
    void Captures.onEngine(
      Effect.all([
        observeMirrorHistory,
        reapOrphanedTransfers,
        settleMirrorBookkeeping,
      ]),
    ).catch(() => {});
  },
});
const LEFT_ACCOUNT_DETAIL =
  "This device left the account. The copy stays as a worktree.";
const endAllMirrors = () =>
  Captures.onEngine(
    endMirrorsWithPeers(() => false, LEFT_ACCOUNT_DETAIL, {
      transfers: true,
    }),
  );
// The sessions the engine brings back for a device on no account
// (registry.ts createNoAccountSweep). The account fan-out's own sweep
// covers a sign-out with the daemon up, and resets this one.
const noAccountSweep = createNoAccountSweep({
  sessions: () => Captures.mirrorSessionsNow(),
  signedIn: accountSignedIn,
  end: () => void endAllMirrors().catch(() => {}),
});

// The mirror sweep of a device leaving its account, bounded so a stuck
// daemon request cannot hold the sign-out: the hub refresh that
// follows closes the sessions the sweep's terminates ride.
function endAllMirrorsBounded(): Promise<unknown> {
  return Promise.race([
    endAllMirrors(),
    new Promise((resolve) => setTimeout(resolve, 5_000).unref?.()),
  ]);
}

// The command-access switch as it now stands, to every connected peer
// (the push is annotated remote). The windows hear it from the shell,
// whose account page flipped it.
function broadcastCommandAccessChanged(): void {
  broadcastAll(accountContract, "commandAccessChanged", acceptsPeerCommands());
}

// A step of the account fan-out that must not take the rest with it.
function teardownStep(what: string, run: () => unknown): Promise<void> {
  return logFailure(`[account] ${what} failed`, run);
}

// The daemon's sessions with the git half of each (host/mirror/
// gitFollow.ts), for the length of the graph: the follower reads the
// daemon's sessions, reaches the peer through the same cached direct
// sessions, and reports through the same changed signal. Its inputs
// are wired below: the local git watcher (layer.ts, via
// announceProjectChanged), the peers' pushes (onPeerPush) and the
// daemon's snapshots (above).
export const mirrorLayer = Layer.effectDiscard(
  mirror.provide(
    Effect.gen(function* () {
      const daemon = yield* MirrorDaemon.MirrorDaemon;
      const follower = yield* makeGitFollower({
        sessions: mirrorSessions(mirrorImpl),
        followDescription: true,
        // The states both sides last agreed on, beside the engine's own
        // data so a restart resumes the follow rule rather than falling
        // back to ancestry.
        agreedStore: {
          load: () =>
            readJsonOrNullSync(gitFollowStorePath(), GitFollowStoreSchema)
              ?.agreed ?? {},
          save: (agreed) =>
            atomicWriteJsonSync(gitFollowStorePath(), { agreed }),
        },
        onChange: () => {
          broadcastMirrorChanged();
          void Captures.onEngine(observeMirrorHistory).catch(() => {});
        },
        // The peer says the session's copy is gone, behind this device's
        // back: confirmed against the peer's own list (an answer while
        // its registry loads, or mid-move, is no removal), the session
        // ends and the original keeps its own.
        onCopyGone: (session) =>
          void Captures.onEngine(endMirrorIfCopyGone(session)).catch(() => {}),
        // A pull it applied here is a ref move the git watcher skips as
        // the app's own: announced like one, so the pages showing it
        // refetch.
        onLocalApplied: (projectId) => announceProjectChanged(projectId),
      });
      return { daemon, follower };
    }),
  ),
);

// "This project's git state moved on this machine": the project-scoped
// ping on every wire (this window and every device viewing this host
// refetch that project's rows), and the mirror's git follower
// re-looking at every session in the project (a commit or checkout
// here must reach the peer). Sent by the git-directory watcher for
// every external ref move, and by the app-run git commands the watcher
// skips as the app's own when no renderer caller invalidates for them.
export function announceProjectChanged(projectId: string): void {
  broadcastAll(gitContract, "projectChanged", { projectId });
  mirror.now()?.follower.onLocalProjectChanged(projectId);
}

// A gateway that fails to bind (a loopback oddity) is retried on a
// slow timer rather than given up on: the daemon starts regardless
// and its own restart ladder picks the address up once bound.
const GATEWAY_RETRY_MS = 30_000;
async function ensureMirrorGateway(): Promise<void> {
  try {
    await mirrorGateway.start();
  } catch (error) {
    log.warn(
      "[mirror] gateway failed to bind, retrying:",
      errorMessageOf(error),
    );
    const timer = setTimeout(
      () => void ensureMirrorGateway(),
      GATEWAY_RETRY_MS,
    );
    timer.unref?.();
  }
}

// The mirror engine's gateway, for layer.ts.
export const startMirrorGateway = ensureMirrorGateway;
export const stopMirrorGateway = () => mirrorGateway.stop();

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
  const previous = setAccountFacts(next);
  const leaving =
    started &&
    previous !== null &&
    (next === null || next.accountId !== previous.accountId);
  const first = !started;
  started = true;
  if (leaving) {
    clearDirectTickets();
    stopPortForwardsTo(() => false);
    await teardownStep("the mirror sweep", endAllMirrorsBounded);
    // After the sweep, so a snapshot during it does not sweep again.
    noAccountSweep.reset();
  }
  // The switch as it now stands, to every connected peer, whose bridge
  // records it for its UI and CLI. An account switch also restarts the
  // listener, so peers learn it from their next dial either way.
  if (!first && previous?.acceptsCommands !== next?.acceptsCommands) {
    broadcastCommandAccessChanged();
  }
  // Also reconciles the listener from its tail, which follows the same
  // enrollment condition.
  const reconnect =
    first ||
    previous?.accountId !== next?.accountId ||
    previous?.hubUrl !== next?.hubUrl ||
    previous?.webOrigin !== next?.webOrigin;
  if (reconnect) await refreshHubConnection();
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
  void Captures.onEngine(
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

export function registerHostHandlers(): void {
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
    invokePeer: (input, ctx) =>
      Effect.tryPromise({
        try: async () => hubHandlers().invokePeer(input, ctx),
        catch: callFailureOf,
      }),
  });
  registerViews(hubContract, {
    watchPeer: (input: Parameters<HubHandlers["watchPeer"]>[0]) =>
      Stream.callback<unknown, unknown>((queue) =>
        Effect.acquireRelease(
          Effect.sync(() =>
            hubHandlers().watchPeer(input, {
              value: (value) => Queue.offerUnsafe(queue, value),
              end: (failure) =>
                failure === undefined
                  ? Queue.endUnsafe(queue)
                  : Queue.failCauseUnsafe(queue, Cause.fail(failure)),
            }),
          ),
          (stop) => Effect.sync(stop),
        ),
      ),
  });
  // Every peer reach of the host (host/ipc/peerSync.ts), riding
  // peerTransportFor above.
  setPeerReach({
    transportFor: peerTransportFor,
    channelsFor: peerChannelsFor,
    thisDeviceId: getDeviceId,
  });
  // The mirrors this device asked peers for (host/mirror/invites.ts),
  // which its switch does not gate: one file beside the follower's.
  setMirrorInviteStore({
    load: () =>
      readJsonOrNullSync(mirrorInvitesPath(), MirrorInviteStoreSchema)
        ?.invites ?? [],
    save: (invites) => atomicWriteJsonSync(mirrorInvitesPath(), { invites }),
  });
  // A copy removed while the app was closed took no invitation with
  // it, so the boot checks the landed ones against the worktrees
  // listed.
  void reconcileMirrorInvites(({ projectId, worktreeId }) =>
    Captures.onEngine(findProjectAndWorktree(projectId, worktreeId)).then(
      () => true,
      // Only a worktree known to be gone loses its invitation. A read
      // that failed for any other reason keeps it.
      (error: unknown) => !isEntityGoneError(error),
    ),
  );
  // The port-forward engine's peer reach, through the same seam as
  // every other (setPeerReach above) and for the same reason:
  // a second session would supersede the one the renderer's
  // remote-forest queries ride. The engine itself is electron-free
  // (host/portForward/engine.ts), and this is its only binding to the
  // peer sessions and to the renderer's changed signal.
  setPortForwardEngine(
    createPortForwardEngine({
      forwardApiFor: (deviceId) => peerClient(forwardContract, deviceId),
      channelsFor: peerChannelsFor,
      onChange: () => {
        broadcastAll(portForwardContract, "changed", undefined);
      },
    }),
  );
  // The listeners belong to this machine, so the surface never mounts
  // on a remote wire.
  registerContract(portForwardContract, portForwardHandlers);
  // The mirror surface: host-scoped (a device's mirrors are its facts,
  // and peers read the list), its daemon injected from above. The
  // serving set (streams this host serves for peers) fans out on the
  // same changed signal.
  setMirrorImpl(mirrorImpl);
  setMirrorServingListener(broadcastMirrorChanged);
  // A delete's removal, to every window and peer (remote:true by
  // contract): the row a mirror stop or a peer's teardown is taking
  // away dims for whoever is looking, not only for the caller, and
  // goes for everyone the moment it is gone.
  setWorktreeRemovalBroadcaster((payload) =>
    broadcastAll(worktreesContract, "removal", payload),
  );
  // A served worktree's index moved: tell the device mirroring it
  // (remote:true, so it rides the peer push path to the follower there).
  setMirrorGitChangedListener((change) =>
    broadcastAll(mirrorContract, "gitChanged", change),
  );
  // A peer's follower landed its side here (a push into a copy): the
  // pages showing the project refetch, as for the follower's own pulls.
  setMirrorGitAppliedListener(announceProjectChanged);
  // The follower's peer-side signals: a peer's git state moved (its
  // git-directory watcher) or a served worktree's index did. And a
  // peer's worktree gone, which ends the mirrors into it running here.
  onPeerPush((push) => {
    if (push.channel === "git:projectChanged") {
      const { payload } = push;
      if (Schema.is(ProjectScopedPayloadSchema)(payload)) {
        mirror
          .now()
          ?.follower.onPeerProjectChanged(push.deviceId, payload.projectId);
      }
    } else if (push.channel === "mirror:gitChanged") {
      const parsed = decodeMirrorWorktreePayload(push.payload);
      if (Option.isSome(parsed)) {
        mirror
          .now()
          ?.follower.onPeerWorktreeChanged(
            push.deviceId,
            parsed.value.projectId,
            parsed.value.worktreeId,
          );
      }
    } else if (push.channel === "worktrees:removal") {
      void Captures.onEngine(
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
  registerContract(worktreesContract, worktreesHandlers);
  registerViews(worktreesContract, worktreesViews);
  registerContract(hygieneContract, hygieneHandlers);
  registerContract(scriptsContract, scriptsHandlers);
  registerViews(scriptsContract, scriptsViews);
  registerContract(terminalsContract, terminalsHandlers);
  registerViews(terminalsContract, terminalsViews);
  // A burst (a lifecycle starting setup and port-pool together, a
  // project's scripts stopped at once) goes out as one ping.
  onRunningScriptsChanged(
    coalesce(() => broadcastAll(scriptsContract, "changed", undefined), 150),
  );
  registerContract(sharedSettingsContract, sharedSettingsHandlers);
  registerViews(sharedSettingsContract, sharedSettingsViews);
  registerContract(sharingContract, sharingHandlers);
  registerViews(sharingContract, sharingViews);
  registerContract(cliContract, cliHandlers);
  // The terminal's cross-device verbs, on the loopback alone
  // (packages/contracts/src/modules/control.ts). The device registry rides the
  // stored credential, and the peers are reached through the seam
  // above.
  setControlImpl({
    listDevices: Effect.tryPromise(listAccountDevices),
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
  });
  registerLoopbackContract(controlContract, controlHandlers, controlTransfers);
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
