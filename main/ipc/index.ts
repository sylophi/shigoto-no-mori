import { accountContract } from "@shared/ipc/modules/account";
import { branchesContract } from "@shared/ipc/modules/branches";
import { clientConfigContract } from "@shared/ipc/modules/clientConfig";
import { dialogContract } from "@shared/ipc/modules/dialog";
import { forwardContract } from "@shared/ipc/modules/forward";
import { fsContract } from "@shared/ipc/modules/fs";
import { gitContract } from "@shared/ipc/modules/git";
import { githubCliContract } from "@shared/ipc/modules/githubCli";
import { globalConfigContract } from "@shared/ipc/modules/globalConfig";
import { hygieneContract } from "@shared/ipc/modules/hygiene";
import { launchersContract } from "@shared/ipc/modules/launchers";
import { menuContract } from "@shared/ipc/modules/menu";
import { packageScriptsContract } from "@shared/ipc/modules/packageScripts";
import { portForwardContract } from "@shared/ipc/modules/portForward";
import { portPoolContract } from "@shared/ipc/modules/portPool";
import { projectsContract } from "@shared/ipc/modules/projects";
import { relayContract } from "@shared/ipc/modules/relay";
import { remoteAccessContract } from "@shared/ipc/modules/remoteAccess";
import { runtimeContract } from "@shared/ipc/modules/runtime";
import { scriptsContract } from "@shared/ipc/modules/scripts";
import { cliContract } from "@shared/ipc/modules/cli";
import { shellContract } from "@shared/ipc/modules/shell";
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
import { packageScriptsHandlers } from "@host/ipc/modules/packageScripts";
import {
  portForwardHandlers,
  setPortForwardEngine,
} from "./modules/portForward";
import { portPoolHandlers } from "@host/ipc/modules/portPool";
import { projectsHandlers } from "@host/ipc/modules/projects";
import { remoteAccessHandlers } from "@host/ipc/modules/remoteAccess";
import { runtimeHandlers } from "@host/ipc/modules/runtime";
import { scriptsHandlers } from "@host/ipc/modules/scripts";
import { cliHandlers } from "@host/ipc/modules/cli";
import { shellHandlers } from "./modules/shell";
import { shigomoriHandlers } from "@host/ipc/modules/shigomori";
import { syncHandlers } from "@host/ipc/modules/sync";
import { updaterHandlers } from "./modules/updater";
import { windowHandlers } from "./modules/window";
import { worktreesHandlers } from "@host/ipc/modules/worktrees";
import { makeRelayHandlers } from "@shared/relay/bridgeHandlers";
import { buildClient } from "@shared/ipc/buildClient";
import { setPeerSyncApiImpl } from "@host/ipc/peerSync";
import { createPortForwardEngine } from "../portForward/engine";
import { makeAccountHandlers } from "./modules/account";
import {
  broadcastAll,
  refreshRelayConnection,
  registerContract,
  relayConnectPeer,
  relayStatus,
} from "./register";

export function registerIpcHandlers(): void {
  registerContract(clientConfigContract, clientConfigHandlers);
  // Client-scoped: sign-in drives the OS browser and writes an
  // OS-keychain credential on this machine, so it never rides the socket
  // wire. The changed broadcast fans out to every window after any
  // sign-in, sign-out or rename, and the relay socket re-reconciles
  // against the fresh account state at the same moment.
  registerContract(
    accountContract,
    makeAccountHandlers(
      () => {
        broadcastAll(accountContract, "changed", undefined);
        // A direct account switch that stays signed in changes which
        // grants apply, so refresh the renderer's granted-set query too.
        // Main's grant cache is already invalidated in makeAccountHandlers
        // (enforcement is correct without this); this only keeps the
        // renderer display fresh, since `changed` invalidates the
        // ["account"] prefix but not ["accountGrants"].
        broadcastAll(accountContract, "grantsChanged", undefined);
        void refreshRelayConnection();
      },
      // A grant or revoke fans out on its own channel so a toggle does
      // not thrash the account status and device queries. No relay
      // reconnect: the link reads the grant predicate live.
      () => {
        broadcastAll(accountContract, "grantsChanged", undefined);
      },
    ),
  );
  // Client-scoped bridge onto the main-process relay socket: status,
  // lazy peer invokes, and the peerPush/statusChanged fan-outs wired in
  // register.ts.
  const relayHandlers = makeRelayHandlers({
    status: relayStatus,
    connectPeer: relayConnectPeer,
  });
  registerContract(relayContract, relayHandlers);
  // The pull/transplant orchestrations' peer reach (host/ipc/peerSync.ts),
  // routed through the SAME invokePeer path (and so the same cached peer
  // session) the renderer's remote-device api uses. Dialing
  // relayConnectPeer directly here would silently replace that session
  // mid-view -- the link keeps one client peer per deviceId.
  const peerTransportFor = (deviceId: string) => ({
    invoke: (channel: string, input: unknown) =>
      Promise.resolve(
        relayHandlers.invokePeer({ deviceId, channel, input }, undefined),
      ),
    subscribe: (): (() => void) => {
      throw new Error("the peer api is invoke-only");
    },
  });
  setPeerSyncApiImpl({
    syncApiFor: (deviceId) =>
      buildClient(syncContract, peerTransportFor(deviceId)),
    worktreesApiFor: (deviceId) =>
      buildClient(worktreesContract, peerTransportFor(deviceId)),
  });
  // The port-forward engine's peer reach, riding the same
  // peerTransportFor as the sync wiring above and for the same reason:
  // a direct relayConnectPeer would silently replace the session the
  // renderer's remote-forest queries ride. The engine itself is
  // electron-free (main/portForward/engine.ts), and this is its only
  // binding to the relay and to the renderer's changed signal.
  setPortForwardEngine(
    createPortForwardEngine({
      forwardApiFor: (deviceId) =>
        buildClient(forwardContract, peerTransportFor(deviceId)),
      onChange: () => {
        broadcastAll(portForwardContract, "changed", undefined);
      },
    }),
  );
  // Client-scoped like dialog and updater: the listeners belong to the
  // machine the window runs on, so the surface never mounts on a
  // remote wire.
  registerContract(portForwardContract, portForwardHandlers);
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
  registerContract(updaterContract, updaterHandlers);
}
