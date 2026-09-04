import { join } from "node:path";
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
import { mirrorContract } from "@shared/ipc/modules/mirror";
import { packageScriptsContract } from "@shared/ipc/modules/packageScripts";
import { portForwardContract } from "@shared/ipc/modules/portForward";
import { portPoolContract } from "@shared/ipc/modules/portPool";
import { portsContract } from "@shared/ipc/modules/ports";
import { projectsContract } from "@shared/ipc/modules/projects";
import { hubContract } from "@shared/ipc/modules/hub";
import { remoteAccessContract } from "@shared/ipc/modules/remoteAccess";
import { runtimeContract } from "@shared/ipc/modules/runtime";
import { scriptsContract } from "@shared/ipc/modules/scripts";
import { cliContract } from "@shared/ipc/modules/cli";
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
import {
  forwardHandlers,
  setMirrorGitChangedListener,
  setMirrorServingListener,
} from "@host/ipc/modules/forward";
import { fsHandlers } from "@host/ipc/modules/fs";
import { gitHandlers } from "@host/ipc/modules/git";
import { githubCliHandlers } from "@host/ipc/modules/githubCli";
import { globalConfigHandlers } from "@host/ipc/modules/globalConfig";
import { hygieneHandlers } from "@host/ipc/modules/hygiene";
import { launchersHandlers } from "@host/ipc/modules/launchers";
import { menuHandlers } from "./modules/menu";
import { mirrorHandlers, setMirrorImpl } from "@host/ipc/modules/mirror";
import { packageScriptsHandlers } from "@host/ipc/modules/packageScripts";
import {
  portForwardHandlers,
  setPortForwardEngine,
} from "./modules/portForward";
import { portPoolHandlers } from "@host/ipc/modules/portPool";
import { portsHandlers } from "@host/ipc/modules/ports";
import { projectsHandlers } from "@host/ipc/modules/projects";
import { remoteAccessHandlers } from "@host/ipc/modules/remoteAccess";
import { runtimeHandlers } from "@host/ipc/modules/runtime";
import { scriptsHandlers } from "@host/ipc/modules/scripts";
import { cliHandlers } from "@host/ipc/modules/cli";
import { shellHandlers } from "./modules/shell";
import { terrierHandlers } from "@host/ipc/modules/terrier";
import { shigomoriHandlers } from "@host/ipc/modules/shigomori";
import { syncHandlers } from "@host/ipc/modules/sync";
import { updaterHandlers } from "@host/ipc/modules/updater";
import { windowHandlers } from "./modules/window";
import { worktreesHandlers } from "@host/ipc/modules/worktrees";
import { buildClient } from "@shared/ipc/buildClient";
import { setPeerSyncApiImpl } from "@host/ipc/peerSync";
import { createPortForwardEngine } from "../portForward/engine";
import { createMirrorDaemon } from "../mirror/daemon";
import { createMirrorGateway } from "../mirror/gateway";
import { createGitFollower } from "@host/mirror/gitFollow";
import { MirrorWorktreePayloadSchema } from "@shared/ipc/modules/mirror";
import { ProjectScopedPayloadSchema } from "@shared/schemas/payloads";
import { spawnFileSync } from "@host/fileSync/spawn";
import { shigomoriRoot } from "@host/lib/util/paths";
import { makeAccountHandlers } from "./modules/account";
import {
  broadcastAll,
  directHandlers,
  refreshHubConnection,
  registerContract,
  hubHandlers,
  onPeerPush,
} from "./register";

// The pull/transplant orchestrations' and the port-forward engine's
// peer reach, routed through the SAME invokePeer path (and so the same
// cached direct peer session) the renderer's remote-device api uses.
// Opening a second session directly would supersede-kill the one every
// remote-forest query is riding, since the host keeps one authed
// socket per device.
const peerTransportFor = (deviceId: string) => ({
  invoke: (channel: string, input: unknown) =>
    Promise.resolve(
      hubHandlers.invokePeer({ deviceId, channel, input }, undefined),
    ),
  subscribe: (): (() => void) => {
    throw new Error("the peer api is invoke-only");
  },
});

// Continuous worktree mirroring, this device's half: the loopback
// gateway the daemon dials peers through and the daemon itself
// (main/mirror/*, both electron-free), bound here to the peer sessions
// and to the renderer's changed signal exactly like the port-forward
// engine. Started from main/index.ts once the app is ready and stopped
// on every quit path; a boot without the engine binary (a dev run
// before file-sync:build) reports "unavailable" and keeps retrying.
const mirrorGateway = createMirrorGateway({
  peerApiFor: (deviceId) =>
    buildClient(forwardContract, peerTransportFor(deviceId)),
  peerChannelsFor: (deviceId) => () => hubHandlers.peerChannels(deviceId),
});
const mirrorDaemon = createMirrorDaemon({
  spawn: spawnFileSync,
  dataDir: () => join(shigomoriRoot(), "file-sync"),
  gatewayAddress: () => {
    const address = mirrorGateway.address();
    if (address === null) throw new Error("mirror gateway is not listening");
    return address;
  },
  onChange: () => {
    broadcastAll(mirrorContract, "changed", undefined);
    gitFollower.sessionsChanged();
  },
});
// The git half of every session this device runs (host/mirror/
// gitFollow.ts): reads the daemon's sessions, reaches the peer through
// the same cached direct sessions, and reports through the same
// changed signal. Its inputs are wired below: the local git watcher
// (main/index.ts, via notifyLocalProjectChanged), the peers' pushes
// (onPeerPush) and the daemon's snapshots (above).
const gitFollower = createGitFollower({
  sessions: () => mirrorDaemon.sessions(),
  peerSyncApiFor: (deviceId) =>
    buildClient(syncContract, peerTransportFor(deviceId)),
  peerMirrorApiFor: (deviceId) =>
    buildClient(mirrorContract, peerTransportFor(deviceId)),
  onChange: () => broadcastAll(mirrorContract, "changed", undefined),
});

export function notifyLocalProjectChanged(projectId: string): void {
  gitFollower.onLocalProjectChanged(projectId);
}

export async function startMirrorEngine(): Promise<void> {
  await mirrorGateway.start();
  mirrorDaemon.start();
  gitFollower.start();
}

export function stopMirrorEngine(): void {
  gitFollower.stop();
  mirrorDaemon.stop();
  mirrorGateway.stop();
}

export function registerIpcHandlers(): void {
  registerContract(clientConfigContract, clientConfigHandlers);
  // Client-scoped: sign-in drives the OS browser and writes an
  // OS-keychain credential on this machine, so it never rides the socket
  // wire. The changed broadcast fans out to every window after any
  // sign-in, sign-out or rename, and the hub socket re-reconciles
  // against the fresh account state at the same moment.
  registerContract(
    accountContract,
    makeAccountHandlers(
      () => {
        broadcastAll(accountContract, "changed", undefined);
        // A direct account switch that stays signed in changes the
        // command-access answer, so refresh the renderer's switch query
        // too. Main's grant cache is already invalidated in
        // makeAccountHandlers, so enforcement is correct without this.
        // This only keeps the renderer display fresh, since `changed`
        // invalidates the ["account"] prefix but not
        // ["accountCommandAccess"].
        broadcastAll(accountContract, "commandAccessChanged", undefined);
        // Also reconciles the direct listener from its tail, which
        // follows the same enrollment condition.
        void refreshHubConnection();
      },
      // The switch flipping fans out on its own channel so the toggle
      // does not thrash the account status and device queries. No hub
      // reconnect: the listener reads the predicate live.
      () => {
        broadcastAll(accountContract, "commandAccessChanged", undefined);
      },
    ),
  );
  // Client-scoped bridge onto the main-process hub socket: status,
  // invokes over the keeper-held direct sessions, and the
  // peerPush/statusChanged fan-outs. The
  // handlers themselves are constructed in register.ts, which owns
  // every dep and folds directPeerVersions back into the status
  // snapshot.
  registerContract(hubContract, hubHandlers);
  // The direct data plane's brokering surface: host-scoped and
  // remote:true, so a peer asks over the device hub (or an existing
  // direct session) how to dial this host directly. The handlers are
  // constructed in register.ts, which owns every dep (the listener, the
  // ticket store, the hub roster). The handler fails closed without an
  // authenticated callerDeviceId, so the Electron wire always reads
  // available:false.
  registerContract(directContract, directHandlers);
  // The sync orchestrations' peer reach (host/ipc/peerSync.ts), riding
  // peerTransportFor above.
  setPeerSyncApiImpl({
    syncApiFor: (deviceId) =>
      buildClient(syncContract, peerTransportFor(deviceId)),
    worktreesApiFor: (deviceId) =>
      buildClient(worktreesContract, peerTransportFor(deviceId)),
    mirrorApiFor: (deviceId) =>
      buildClient(mirrorContract, peerTransportFor(deviceId)),
  });
  // The port-forward engine's peer reach, riding the same
  // peerTransportFor as the sync wiring above and for the same reason:
  // a second session would supersede the one the renderer's
  // remote-forest queries ride. The engine itself is electron-free
  // (main/portForward/engine.ts), and this is its only binding to the
  // peer sessions and to the renderer's changed signal.
  setPortForwardEngine(
    createPortForwardEngine({
      forwardApiFor: (deviceId) =>
        buildClient(forwardContract, peerTransportFor(deviceId)),
      // The byte channels of the same cached direct session.
      channelsFor: (deviceId) => () => hubHandlers.peerChannels(deviceId),
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
    create: (input) => mirrorDaemon.create(input),
    terminate: (session) => mirrorDaemon.terminate(session),
    pause: (session) => mirrorDaemon.pause(session),
    resume: (session) => mirrorDaemon.resume(session),
    gitStatus: (session) => gitFollower.statusOf(session),
  });
  setMirrorServingListener(() =>
    broadcastAll(mirrorContract, "changed", undefined),
  );
  // A served worktree's index moved: tell the device mirroring it
  // (remote:true, so it rides the peer push path to the follower there).
  setMirrorGitChangedListener((change) =>
    broadcastAll(mirrorContract, "gitChanged", change),
  );
  // The follower's peer-side signals: a peer's git state moved (its
  // git-directory watcher) or a served worktree's index did.
  onPeerPush((push) => {
    if (push.channel === "git:projectChanged") {
      const parsed = ProjectScopedPayloadSchema.safeParse(push.payload);
      if (parsed.success) {
        gitFollower.onPeerProjectChanged(push.deviceId, parsed.data.projectId);
      }
    } else if (push.channel === "mirror:gitChanged") {
      const parsed = MirrorWorktreePayloadSchema.safeParse(push.payload);
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
  registerContract(cliContract, cliHandlers);
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
