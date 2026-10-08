// Every handler this device serves, assembled and put on the wires.
// The wires themselves are register.ts (the Electron and websocket
// bindings, broadcast, and the hub and direct plane's lifecycle). This
// file is what rides them: it builds each contract module's handler map
// from host/ipc/modules and ./modules, binds the two engines that need
// peer reach (the mirror daemon and the port forwards) to the same peer
// sessions the renderer uses, and registers the lot in
// registerIpcHandlers, which main/index.ts calls once at boot.
import { join } from "node:path";
import { accountContract } from "@shigomori/contracts/modules/account";
import { branchesContract } from "@shigomori/contracts/modules/branches";
import { clientConfigContract } from "@shigomori/contracts/modules/clientConfig";
import { dialogContract } from "@shigomori/contracts/modules/dialog";
import { forwardContract } from "@shigomori/contracts/modules/forward";
import { fsContract } from "@shigomori/contracts/modules/fs";
import { gitContract } from "@shigomori/contracts/modules/git";
import { githubCliContract } from "@shigomori/contracts/modules/githubCli";
import { globalConfigContract } from "@shigomori/contracts/modules/globalConfig";
import { hygieneContract } from "@shigomori/contracts/modules/hygiene";
import { launchersContract } from "@shigomori/contracts/modules/launchers";
import { menuContract } from "@shigomori/contracts/modules/menu";
import { navContract } from "@shigomori/contracts/modules/nav";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { coalesce } from "@host/lib/util/coalesce";
import {
  GitStateCoreSchema,
  MirrorEventSchema,
  MirrorWorktreePayloadSchema,
  mirrorContract,
} from "@shigomori/contracts/modules/mirror";
import { errorMessageOf, isEntityGoneError } from "@shigomori/contracts/errors";
import { packageScriptsContract } from "@shigomori/contracts/modules/packageScripts";
import { portForwardContract } from "@shigomori/contracts/modules/portForward";
import { portPoolContract } from "@shigomori/contracts/modules/portPool";
import { portsContract } from "@shigomori/contracts/modules/ports";
import { projectsContract } from "@shigomori/contracts/modules/projects";
import { hubContract } from "@shigomori/contracts/modules/hub";
import { runtimeContract } from "@shigomori/contracts/modules/runtime";
import { scriptsContract } from "@shigomori/contracts/modules/scripts";
import { sharedSettingsContract } from "@shigomori/contracts/modules/sharedSettings";
import { cliContract } from "@shigomori/contracts/modules/cli";
import { controlContract } from "@shigomori/contracts/modules/control";
import { releasesContract } from "@shigomori/contracts/modules/releases";
import { shellContract } from "@shigomori/contracts/modules/shell";
import { terrierContract } from "@shigomori/contracts/modules/terrier";
import { shigomoriContract } from "@shigomori/contracts/modules/shigomori";
import { worktreeDataContract } from "@shigomori/contracts/modules/worktreeData";
import { syncContract } from "@shigomori/contracts/modules/sync";
import { updaterContract } from "@shigomori/contracts/modules/updater";
import { villagersContract } from "@shigomori/contracts/modules/villagers";
import { windowContract } from "@shigomori/contracts/modules/window";
import { worktreesContract } from "@shigomori/contracts/modules/worktrees";
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
import {
  currentMirrorList,
  endMirrorIfCopyGone,
  mirrorHandlers,
  setMirrorGitAppliedListener,
  setMirrorGitChangedListener,
  setMirrorImpl,
  setMirrorServingListener,
} from "@host/ipc/modules/mirror";
import {
  createNoAccountSweep,
  endLegacyMirrors,
  endMirrorsOnPeerRemoval,
  endMirrorsWithPeers,
  settleMirrorBookkeeping,
  whileRecreating,
  isOrphanedTransfer,
  mirrorSessions,
} from "@host/mirror/registry";
import {
  MirrorInviteSchema,
  reconcileMirrorInvites,
  setMirrorInviteStore,
} from "@host/mirror/invites";
import { findProjectAndWorktreeOrThrow } from "@host/lib/projects";
import { onRunningScriptsChanged } from "@host/lib/scripts";
import { packageScriptsHandlers } from "@host/ipc/modules/packageScripts";
import {
  portForwardHandlers,
  setPortForwardEngine,
  stopPortForwardsTo,
} from "./modules/portForward";
import { portPoolHandlers } from "@host/ipc/modules/portPool";
import { portsHandlers } from "@host/ipc/modules/ports";
import { projectsHandlers } from "@host/ipc/modules/projects";
import { runtimeHandlers } from "@host/ipc/modules/runtime";
import { scriptsHandlers } from "@host/ipc/modules/scripts";
import { sharedSettingsHandlers } from "@host/ipc/modules/sharedSettings";
import { sharedSettingsCopy } from "@host/lib/sharedSettings/store";
import { cliHandlers } from "@host/ipc/modules/cli";
import { controlHandlers } from "@host/ipc/modules/control";
import { setControlImpl } from "@host/lib/control/peers";
import { releasesHandlers } from "./modules/releases";
import { shellHandlers } from "./modules/shell";
import { terrierHandlers } from "@host/ipc/modules/terrier";
import { shigomoriHandlers } from "@host/ipc/modules/shigomori";
import { worktreeDataHandlers } from "@host/ipc/modules/worktreeData";
import { syncHandlers } from "@host/ipc/modules/sync";
import { updaterHandlers } from "@host/ipc/modules/updater";
import { villagersHandlers } from "@host/ipc/modules/villagers";
import { windowHandlers } from "./modules/window";
import { navHandlers } from "./modules/nav";
import {
  setWorktreeRemovalBroadcaster,
  worktreesHandlers,
} from "@host/ipc/modules/worktrees";
import type { ClientTransport } from "@shared/ipc/transport";
import {
  peerClient,
  peerMirrorApiFor,
  peerSyncApiFor,
  setPeerReach,
} from "@host/ipc/peerSync";
import { followDescription } from "@host/lib/sync/worktreeDescription";
import { createPortForwardEngine } from "../core/portForward/engine";
import * as MirrorDaemon from "../core/mirror/daemon";
import { createMirrorGateway } from "../core/mirror/gateway";
import { createMirrorHistory } from "../core/mirror/history";
import { createGitFollower } from "@host/mirror/gitFollow";
import {
  atomicWriteJsonSync,
  readJsonOrNullSync,
  withSchemaVersion,
} from "@host/lib/util/jsonFile";
import { ProjectScopedPayloadSchema } from "@shigomori/contracts/schemas/payloads";
import { dataDir } from "@host/lib/util/paths";
import { getDeviceId } from "@host/lib/config/deviceId";
import {
  acceptsPeerCommands,
  accountSignedIn,
  makeAccountHandlers,
} from "./modules/account";
import { hubConnectInputs } from "./modules/account";
import { reconcileLaunchAtLogin } from "../electron/liveness";
import { withoutPeerState } from "@shigomori/contracts/schemas/config";
import {
  readClientConfigSync,
  writeClientConfig,
} from "../electron/clientConfig";
import {
  broadcastAll,
  clearDirectTickets,
  refreshHubConnection,
  registerContract,
  registerControlContract,
  hubHandlers,
  onPeerPush,
} from "./register";
import { log, logFailure } from "@shared/log";

// The pull/transplant orchestrations' and the port-forward engine's
// peer reach, routed through the SAME invokePeer path (and so the same
// cached direct peer session) the renderer's remote-device api uses.
// Opening a second session directly would supersede-kill the one every
// remote-forest query is riding, since the host keeps one authed
// socket per device.
const peerTransportFor = (deviceId: string): ClientTransport => ({
  invoke: (channel: string, input: unknown) =>
    Promise.resolve(
      hubHandlers.invokePeer({ deviceId, channel, input }, undefined),
    ),
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

// Continuous worktree mirroring, this device's half: the loopback
// gateway the daemon dials peers through and the daemon itself
// (main/core/mirror/*, both electron-free), bound here to the peer sessions
// and to the renderer's changed signal exactly like the port-forward
// engine. Started and stopped by the host's layer graph
// (main/hostLayer.ts). A boot without the engine binary (a dev run
// before file-sync:build) reports "unavailable" and keeps retrying.
// The byte channels of a peer's cached direct session.
const peerChannelsFor = (deviceId: string) => () =>
  hubHandlers.peerChannels(deviceId);

const mirrorGateway = createMirrorGateway({
  peerApiFor: (deviceId) => peerClient(mirrorContract, deviceId),
  peerChannelsFor,
});
// The daemon snapshots on every cycle of every session and the
// follower reports every verdict. The renderer's ping is coalesced so
// a busy mirror costs viewers one refetch per beat, not one per cycle.
const broadcastMirrorChanged = coalesce(() => {
  // Off a timer, so a throw here is the main process's uncaught
  // exception. The list is validated against its strict schema on the
  // way out, and one that fails it goes out as the bare signal (a
  // reader then asks), as it did before the broadcast carried a list.
  try {
    broadcastAll(mirrorContract, "changed", currentMirrorList());
  } catch (error) {
    log.warn(
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
    save: (events) =>
      atomicWriteJsonSync(mirrorHistoryPath(), withSchemaVersion({ events })),
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
    if (!isOrphanedTransfer(session) || reaped.has(session.session)) continue;
    reaped.add(session.session);
    void mirrorDaemon.terminate(session.session).catch((error: unknown) => {
      log.warn(
        `[mirror] could not end an orphaned transfer session: ${errorMessageOf(error)}`,
      );
    });
  }
};
const observeMirrorHistory = () =>
  mirrorHistory.observe(liveMirrorSessions(), (session) =>
    gitFollower.statusOf(session),
  );
// The gateway's facts the daemon is handed, once it has them.
function listening<T>(value: T | null): T {
  if (value === null) throw new Error("mirror gateway is not listening");
  return value;
}

const { mirrorDaemon } = MirrorDaemon;
export const mirrorDaemonLayer = MirrorDaemon.layer({
  dataDir: fileSyncDir,
  gatewayAddress: () => listening(mirrorGateway.address()),
  gatewayToken: () => listening(mirrorGateway.token()),
  onChange: () => {
    broadcastMirrorChanged();
    // The follower compares the session set itself. A snapshot that
    // only moved a cycle count is a no-op there.
    gitFollower.sessionsChanged();
    observeMirrorHistory();
    reapOrphanedTransfers();
    // A mirror an older build started from the copy's device
    // (registry.ts isLegacyMirror), ended once, the worktree kept.
    void endLegacyMirrors();
    noAccountSweep.run();
    // The stops that waited for the daemon, originals gone behind the
    // app's back, sessions a re-open replaced (registry.ts).
    void settleMirrorBookkeeping();
  },
});
const LEFT_ACCOUNT_DETAIL =
  "This device left the account. The copy stays as a worktree.";
function endAllMirrors(): Promise<void> {
  return endMirrorsWithPeers(() => false, LEFT_ACCOUNT_DETAIL, {
    transfers: true,
  });
}
// The sessions the engine brings back for a device on no account
// (registry.ts createNoAccountSweep). The account fan-out's own sweep
// covers a sign-out with the daemon up, and resets this one.
const noAccountSweep = createNoAccountSweep({
  sessions: () => mirrorDaemon.sessions(),
  signedIn: accountSignedIn,
  end: () => void endAllMirrors(),
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

// The command-access switch as it now stands, to this device's windows
// (the account page toggle) and, the broadcast being tagged remote, to
// every connected peer, whose bridge records it for its UI and CLI.
function broadcastCommandAccessChanged(): void {
  broadcastAll(accountContract, "commandAccessChanged", acceptsPeerCommands());
}

// A step of the account fan-out that must not take the rest with it.
function teardownStep(what: string, run: () => unknown): Promise<void> {
  return logFailure(`[account] ${what} failed`, run);
}
// The git half of every session this device runs (host/mirror/
// gitFollow.ts): reads the daemon's sessions, reaches the peer through
// the same cached direct sessions, and reports through the same
// changed signal. Its inputs are wired below: the local git watcher
// (main/index.ts, via announceProjectChanged), the peers' pushes
// (onPeerPush) and the daemon's snapshots (above).
const gitFollower = createGitFollower({
  sessions: liveMirrorSessions,
  peerSyncApiFor,
  peerMirrorApiFor,
  followDescription,
  // The states both sides last agreed on, beside the engine's own
  // data so a restart resumes the follow rule rather than falling
  // back to ancestry.
  agreedStore: {
    load: () =>
      readJsonOrNullSync(gitFollowStorePath(), GitFollowStoreSchema)?.agreed ??
      {},
    save: (agreed) =>
      atomicWriteJsonSync(gitFollowStorePath(), withSchemaVersion({ agreed })),
  },
  onChange: () => {
    broadcastMirrorChanged();
    observeMirrorHistory();
  },
  // The peer says the session's copy is gone, behind this device's
  // back: confirmed against the peer's own list (an answer while its
  // registry loads, or mid-move, is no removal), the session ends and
  // the original keeps its own.
  onCopyGone: (session) => void endMirrorIfCopyGone(session),
  // A pull it applied here is a ref move the git watcher skips as the
  // app's own: announced like one, so the pages showing it refetch.
  onLocalApplied: (projectId) => announceProjectChanged(projectId),
});

// "This project's git state moved on this machine": the project-scoped
// ping on every wire (this window and every device viewing this host
// refetch that project's rows), and the mirror's git follower
// re-looking at every session in the project (a commit or checkout
// here must reach the peer). Sent by the git-directory watcher for
// every external ref move, and by the app-run git commands the watcher
// skips as the app's own when no renderer caller invalidates for them.
export function announceProjectChanged(projectId: string): void {
  broadcastAll(gitContract, "projectChanged", { projectId });
  gitFollower.onLocalProjectChanged(projectId);
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

// The mirror engine's pieces, for main/hostLayer.ts.
export const startMirrorGateway = ensureMirrorGateway;
export const stopMirrorGateway = () => mirrorGateway.stop();
export const startGitFollower = () => gitFollower.start();
export const stopGitFollower = () => gitFollower.stop();

export function registerIpcHandlers(): void {
  registerContract(clientConfigContract, clientConfigHandlers);
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
  const accountHandlers = makeAccountHandlers(
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
        // After the sweep, so a snapshot during it does not sweep again.
        noAccountSweep.reset();
        await teardownStep("dropping the peer-keyed client config", () =>
          writeClientConfig(withoutPeerState(readClientConfigSync())),
        );
      }
      broadcastAll(accountContract, "changed", { accountId });
      // A direct account switch that stays signed in changes the
      // command-access answer, so refresh the renderer's switch query
      // too. Main's mirror of the switch is already dropped in
      // makeAccountHandlers, so enforcement is correct without this.
      // This only keeps the display fresh, since `changed` invalidates
      // the ["account"] prefix but not ["accountCommandAccess"]. (An
      // account switch also restarts the direct listener, so peers
      // learn the new answer from their next dial either way.)
      broadcastCommandAccessChanged();
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
    // does not thrash the account status and device queries. No
    // reconnect: the listener reads the predicate live. The peers hear
    // it too (remote:true), so their reading follows at once.
    broadcastCommandAccessChanged,
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
  registerContract(accountContract, accountHandlers);
  // Client-scoped bridge onto the main-process hub socket: status,
  // invokes over the keeper-held direct sessions, and the
  // peerPush/statusChanged fan-outs. The
  // handlers themselves are constructed in register.ts, which owns
  // every dep and folds directPeerVersions back into the status
  // snapshot.
  registerContract(hubContract, hubHandlers);
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
    save: (invites) =>
      atomicWriteJsonSync(mirrorInvitesPath(), withSchemaVersion({ invites })),
  });
  // A copy removed while the app was closed took no invitation with
  // it, so the boot checks the landed ones against the worktrees
  // listed.
  void reconcileMirrorInvites(({ projectId, worktreeId }) =>
    findProjectAndWorktreeOrThrow(projectId, worktreeId).then(
      () => true,
      // Only a worktree known to be gone loses its invitation. A read
      // that failed for any other reason keeps it.
      (error: unknown) => !isEntityGoneError(error),
    ),
  );
  // The port-forward engine's peer reach, riding the same
  // peerTransportFor as the sync wiring above and for the same reason:
  // a second session would supersede the one the renderer's
  // remote-forest queries ride. The engine itself is electron-free
  // (main/core/portForward/engine.ts), and this is its only binding to the
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
  // Client-scoped like dialog: the listeners belong to the machine the
  // window runs on, so the surface never mounts on a remote wire.
  registerContract(portForwardContract, portForwardHandlers);
  // The mirror surface: host-scoped (a device's mirrors are its facts,
  // and peers read the list), its daemon injected from above. The
  // serving set (streams this host serves for peers) fans out on the
  // same changed signal.
  setMirrorImpl({
    status: () => mirrorDaemon.status(),
    sessions: () => mirrorDaemon.sessions(),
    create: (input) => {
      // A start's long leg (the copy across) can straddle a sign-out;
      // the sweep that ran meanwhile found nothing, so this is the
      // last gate before a session with a peer of no account.
      if (hubConnectInputs() === null) {
        throw new Error("This device is signed out, so it cannot mirror.");
      }
      return mirrorDaemon.create(input);
    },
    // The old session is paused, not ended, until the new one is up:
    // two running sessions on one root would fight, but a paused one
    // holds nothing, and a create that fails (peer away) then leaves
    // the mirror as it was instead of gone with no way to re-open it.
    // The agreement moves to the new id, so the follower picks up
    // where it was instead of starting from the no-agreement fallback.
    // Held as recreating throughout, so the leftover sweep
    // (registry.ts settleMirrorBookkeeping) does not end the old
    // session under it. An old session already gone by the terminate
    // was ended all the same.
    recreate: (session, input) =>
      whileRecreating(session, async () => {
        await mirrorDaemon.pause(session);
        let next: string;
        try {
          next = await mirrorDaemon.create(input);
        } catch (error) {
          await mirrorDaemon.resume(session).catch(() => {});
          throw error;
        }
        await mirrorDaemon.terminate(session).catch((error: unknown) => {
          const stillThere = mirrorDaemon
            .sessions()
            .some((raw) => raw.session === session);
          if (stillThere) throw error;
        });
        gitFollower.rename(session, next);
        return next;
      }),
    terminate: async (session) => {
      try {
        await mirrorDaemon.terminate(session);
      } finally {
        // An explicit stop ends the agreement too, or the git
        // follower's store keeps one entry per session ever created.
        // A terminate that failed still ends it: the session is
        // doomed either way, and the entry would otherwise outlive
        // the daemon that could ever match it.
        gitFollower.forget(session);
      }
    },
    pause: (session) => mirrorDaemon.pause(session),
    resume: (session) => mirrorDaemon.resume(session),
    gitStatus: (session) => gitFollower.statusOf(session),
    refreshGit: (session) => gitFollower.reconcileNow(session),
    history: (localWorktreeId) => mirrorHistory.eventsFor(localWorktreeId),
    noteEvent: (localWorktreeId, kind, detail) =>
      mirrorHistory.note(localWorktreeId, kind, detail),
    forgetHistory: (localWorktreeId) => mirrorHistory.forget(localWorktreeId),
    moveHistory: (from, to) => mirrorHistory.move(from, to),
  });
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
        gitFollower.onPeerProjectChanged(push.deviceId, payload.projectId);
      }
    } else if (push.channel === "mirror:gitChanged") {
      const parsed = decodeMirrorWorktreePayload(push.payload);
      if (Option.isSome(parsed)) {
        gitFollower.onPeerWorktreeChanged(
          push.deviceId,
          parsed.value.projectId,
          parsed.value.worktreeId,
        );
      }
    } else if (push.channel === "worktrees:removal") {
      void endMirrorsOnPeerRemoval(push.deviceId, push.payload);
    }
  });
  registerContract(mirrorContract, mirrorHandlers);
  registerContract(windowContract, windowHandlers);
  registerContract(navContract, navHandlers);
  registerContract(projectsContract, projectsHandlers);
  registerContract(dialogContract, dialogHandlers);
  registerContract(runtimeContract, runtimeHandlers);
  registerContract(shellContract, shellHandlers);
  registerContract(releasesContract, releasesHandlers);
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
  // A burst (a lifecycle starting setup and port-pool together, a
  // project's scripts stopped at once) goes out as one ping.
  onRunningScriptsChanged(
    coalesce(() => broadcastAll(scriptsContract, "changed", undefined), 150),
  );
  registerContract(sharedSettingsContract, sharedSettingsHandlers);
  registerContract(cliContract, cliHandlers);
  // The CLI's cross-device verbs, on the control wire alone
  // (packages/contracts/src/modules/control.ts). The device registry rides the
  // stored credential, and the peers are reached through the seam
  // above.
  setControlImpl({
    listDevices: async () => [
      ...(await accountHandlers.listDevices(undefined, undefined)),
    ],
    directPeers: async () =>
      (await hubHandlers.status(undefined, undefined)).peerAcceptsCommands,
  });
  registerControlContract(controlContract, controlHandlers);
  registerContract(shigomoriContract, shigomoriHandlers);
  registerContract(worktreeDataContract, worktreeDataHandlers);
  registerContract(syncContract, syncHandlers);
  // Host side of the port-forward wire: host-scoped, so it mounts on
  // the Electron wire and the direct listener, whose command-access
  // gate covers every verb (all gated).
  registerContract(forwardContract, forwardHandlers);
  // Host-scoped: a peer's Settings page reads this device's update
  // state and, when granted, checks or restarts into an update here.
  registerContract(updaterContract, updaterHandlers);
  // Local only: the villager data in this device's data dir, for its
  // own window's Village life.
  registerContract(villagersContract, villagersHandlers);
}
