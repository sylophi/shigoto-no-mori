import { accountContract } from "@shared/ipc/modules/account";
import { branchesContract } from "@shared/ipc/modules/branches";
import { clientConfigContract } from "@shared/ipc/modules/clientConfig";
import { dialogContract } from "@shared/ipc/modules/dialog";
import { fsContract } from "@shared/ipc/modules/fs";
import { gitContract } from "@shared/ipc/modules/git";
import { githubCliContract } from "@shared/ipc/modules/githubCli";
import { globalConfigContract } from "@shared/ipc/modules/globalConfig";
import { hygieneContract } from "@shared/ipc/modules/hygiene";
import { launchersContract } from "@shared/ipc/modules/launchers";
import { menuContract } from "@shared/ipc/modules/menu";
import { packageScriptsContract } from "@shared/ipc/modules/packageScripts";
import { portPoolContract } from "@shared/ipc/modules/portPool";
import { projectsContract } from "@shared/ipc/modules/projects";
import { relayContract } from "@shared/ipc/modules/relay";
import { remoteAccessContract } from "@shared/ipc/modules/remoteAccess";
import { runtimeContract } from "@shared/ipc/modules/runtime";
import { scriptsContract } from "@shared/ipc/modules/scripts";
import { cliContract } from "@shared/ipc/modules/cli";
import { shellContract } from "@shared/ipc/modules/shell";
import { shigomoriContract } from "@shared/ipc/modules/shigomori";
import { updaterContract } from "@shared/ipc/modules/updater";
import { windowContract } from "@shared/ipc/modules/window";
import { worktreesContract } from "@shared/ipc/modules/worktrees";
import { branchesHandlers } from "@host/ipc/modules/branches";
import { clientConfigHandlers } from "./modules/clientConfig";
import { dialogHandlers } from "./modules/dialog";
import { fsHandlers } from "@host/ipc/modules/fs";
import { gitHandlers } from "@host/ipc/modules/git";
import { githubCliHandlers } from "@host/ipc/modules/githubCli";
import { globalConfigHandlers } from "@host/ipc/modules/globalConfig";
import { hygieneHandlers } from "@host/ipc/modules/hygiene";
import { launchersHandlers } from "@host/ipc/modules/launchers";
import { menuHandlers } from "./modules/menu";
import { packageScriptsHandlers } from "@host/ipc/modules/packageScripts";
import { portPoolHandlers } from "@host/ipc/modules/portPool";
import { projectsHandlers } from "@host/ipc/modules/projects";
import { remoteAccessHandlers } from "@host/ipc/modules/remoteAccess";
import { runtimeHandlers } from "@host/ipc/modules/runtime";
import { scriptsHandlers } from "@host/ipc/modules/scripts";
import { cliHandlers } from "@host/ipc/modules/cli";
import { shellHandlers } from "./modules/shell";
import { shigomoriHandlers } from "@host/ipc/modules/shigomori";
import { updaterHandlers } from "./modules/updater";
import { windowHandlers } from "./modules/window";
import { worktreesHandlers } from "@host/ipc/modules/worktrees";
import { makeRelayHandlers } from "@shared/relay/bridgeHandlers";
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
  registerContract(
    relayContract,
    makeRelayHandlers({ status: relayStatus, connectPeer: relayConnectPeer }),
  );
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
  registerContract(updaterContract, updaterHandlers);
}
