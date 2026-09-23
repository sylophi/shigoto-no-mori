// The Electron-side implementations of the host's services, and of the
// two main-side ones the handler modules read (the menu and the
// port-forward engine's handler map): handler modules stay free of
// Electron imports, and every Electron-backed capability they need
// arrives as a service in the runtime main/index.ts installs before
// registerIpcHandlers, so the first renderer call never lands on a
// runtime without it.
import { shell } from "electron";
import { Effect, Layer } from "effect";
import { mirrorContract } from "@shared/ipc/modules/mirror";
import { runtimeContract } from "@shared/ipc/modules/runtime";
import { sharedSettingsContract } from "@shared/ipc/modules/sharedSettings";
import { syncContract } from "@shared/ipc/modules/sync";
import { worktreesContract } from "@shared/ipc/modules/worktrees";
import { buildClient } from "@shared/ipc/buildClient";
import { CliRunner } from "@host/ipc/cliDelegate";
import { onGlobalConfigChange } from "@host/lib/config/global";
import { getDeviceId } from "@host/lib/config/deviceId";
import { onSharedSettingsChange } from "@host/lib/sharedSettings/store";
import { CliTools } from "@host/ipc/modules/cli";
import { ControlReach } from "@host/ipc/modules/control";
import { BackgroundFetch } from "@host/ipc/modules/git";
import { Launchers } from "@host/ipc/modules/launchers";
import {
  MirrorGitChangedListener,
  MirrorServingListener,
} from "@host/ipc/modules/mirror";
import { AppLifecycle } from "@host/ipc/modules/runtime";
import { Updater } from "@host/ipc/modules/updater";
import { PeerApis } from "@host/ipc/peerSync";
import { FileSyncSpawn } from "@host/fileSync/spawn";
import { MirrorEngine } from "@host/mirror/registry";
import {
  AccountHandlers,
  broadcastMirrorChanged,
  GitFollower,
  MirrorDaemon,
  MirrorHistory,
  peerTransportVia,
} from "../ipc/handlers";
import { hubConnectInputs } from "../ipc/modules/account";
import { Menu } from "../ipc/modules/menu";
import {
  broadcastAll,
  DirectPlane,
  refreshDirectHost,
  refreshSocketHost,
  republishControlHost,
  stopControlHost,
} from "../ipc/register";
import {
  cliLinkStatus,
  installCliLinks,
  uninstallCliEverything,
} from "./cliInstall";
import { cliFailureMessage, requireCliBinary, runCli } from "./cliRunner";
import { spawnBundledFileSync } from "./fileSyncRunner";
import {
  installShellIntegration,
  shellIntegrationStatus,
  uninstallShellIntegration,
} from "./cliShell";
import { busyActionRemoteRefusal } from "./busyPrompt";
import { refreshProject, sweepForPeer } from "./fetch";
import { setLaunchToolsEnabled } from "./menu";
import { relaunchAppUnattended } from "./relaunch";
import { stopStateWatcher } from "./stateWatcher";
import { updaterImpl } from "./updater";
import { stopUpdaterBridge } from "./updaterBridge";

// The ones that are plain Electron-side functions.
const ElectronImplsLive = Layer.mergeAll(
  Layer.succeed(CliTools, {
    cliLinkStatus,
    installCliLinks,
    uninstallCliEverything,
    shellIntegrationStatus,
    installShellIntegration,
    uninstallShellIntegration,
  }),
  Layer.succeed(BackgroundFetch, { refreshProject, sweepForPeer }),
  Layer.succeed(Launchers, { openExternal: (url) => shell.openExternal(url) }),
  Layer.succeed(AppLifecycle, {
    uninstallCliEverything,
    stopStateWatcher,
    stopUpdaterBridge,
    stopControlHost,
    broadcastNukeProgress: (progress) =>
      broadcastAll(runtimeContract, "nukeProgress", progress),
    afterDataWipe: republishControlHost,
    relaunchAppUnattended,
    unattendedMoveRefusal: () => busyActionRemoteRefusal("move"),
  }),
  Layer.succeed(CliRunner, { runCli, requireCliBinary, cliFailureMessage }),
  Layer.succeed(Updater, updaterImpl),
  Layer.succeed(FileSyncSpawn, spawnBundledFileSync),
  Layer.succeed(Menu, setLaunchToolsEnabled),
  // The serving set (streams this host serves for peers) fans out on
  // the mirror's changed signal.
  Layer.succeed(MirrorServingListener, broadcastMirrorChanged),
  // A served worktree's index moved: tell the device mirroring it
  // (remote:true, so it rides the peer push path to the follower there).
  Layer.succeed(MirrorGitChangedListener, (change) =>
    broadcastAll(mirrorContract, "gitChanged", change),
  ),
);

// The host's subscriptions to main-side signals, held for the
// runtime's life.
const SubscriptionsLive = Layer.effectDiscard(
  Effect.gen(function* () {
    // Reconcile the socket listeners on every config change, whatever
    // the path: the IPC write handler, an external CLI write picked up
    // by the state watcher, and nuke wiping config.json all fan out
    // through invalidateGlobalConfigCache to this one subscriber. The
    // direct listener reconciles too so the directConnections opt-out
    // applies without a relaunch. Registered once here, and neither
    // refresh ever rejects, so fire and forget is safe. The boot-time
    // pass is main/index.ts's own refresh calls, since this fires only
    // on a subsequent change.
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        onGlobalConfigChange(() => {
          void refreshSocketHost();
          void refreshDirectHost();
        }),
      ),
      (unsubscribe) => Effect.sync(unsubscribe),
    );
    // This device's copy of the shared settings moved (a pick here, or a
    // peer's entries merged in): every window re-reads it off the
    // broadcast, and every peer's window folds it into its own copy.
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        onSharedSettingsChange((doc) =>
          broadcastAll(sharedSettingsContract, "changed", doc),
        ),
      ),
      (unsubscribe) => Effect.sync(unsubscribe),
    );
  }),
);

// The sync orchestrations' peer reach (host/ipc/peerSync.ts), riding
// the same cached direct sessions the renderer's remote-device api
// uses (peerTransportVia says why).
const PeerApisLive = Layer.effect(
  PeerApis,
  Effect.map(DirectPlane, (plane) => {
    const peerTransportFor = peerTransportVia(plane);
    return {
      syncApiFor: (deviceId: string) =>
        buildClient(syncContract, peerTransportFor(deviceId)),
      worktreesApiFor: (deviceId: string) =>
        buildClient(worktreesContract, peerTransportFor(deviceId)),
    };
  }),
);

// The mirror surface's daemon (host/mirror/registry.ts), over the
// runners main/ipc/handlers.ts builds.
const MirrorEngineImplLive = Layer.effect(
  MirrorEngine,
  Effect.gen(function* () {
    const mirrorDaemon = yield* MirrorDaemon;
    const gitFollower = yield* GitFollower;
    const mirrorHistory = yield* MirrorHistory;
    return {
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
      recreate: async (session, input) => {
        await mirrorDaemon.pause(session);
        let next: string;
        try {
          next = await mirrorDaemon.create(input);
        } catch (error) {
          await mirrorDaemon.resume(session).catch(() => {});
          throw error;
        }
        await mirrorDaemon.terminate(session);
        gitFollower.rename(session, next);
        return next;
      },
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
      history: (localWorktreeId) => mirrorHistory.eventsFor(localWorktreeId),
      noteEvent: (localWorktreeId, kind, detail) =>
        mirrorHistory.note(localWorktreeId, kind, detail),
      forgetHistory: (localWorktreeId) => mirrorHistory.forget(localWorktreeId),
    };
  }),
);

// The CLI's cross-device verbs (host/ipc/modules/control.ts). The
// device registry rides the stored credential through the account
// handlers, and the peer reach is peerTransportVia, the one cached
// session per peer everything else rides.
const ControlReachLive = Layer.effect(
  ControlReach,
  Effect.gen(function* () {
    const accountHandlers = yield* AccountHandlers;
    const plane = yield* DirectPlane;
    return {
      listDevices: async () =>
        accountHandlers.listDevices(undefined, undefined),
      thisDeviceId: getDeviceId,
      connectedDeviceIds: async () =>
        Object.keys(
          (await plane.handlers.status(undefined, undefined)).peerAppVersions,
        ),
      peerTransportFor: peerTransportVia(plane),
    };
  }),
);

export const HostImplsLive = Layer.mergeAll(
  ElectronImplsLive,
  SubscriptionsLive,
  PeerApisLive,
  MirrorEngineImplLive,
  ControlReachLive,
);
