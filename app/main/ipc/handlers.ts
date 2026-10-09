// Every handler the shell serves its windows, assembled and registered
// in registerShellHandlers, once at boot: the client modules whose
// state is this machine as Electron sees it. The host's are
// host/process/handlers.ts. The account is the shell's (its credential
// is in the keychain), and every change to it is reported to the host,
// which runs the hub socket and the peer-facing state it gates.
import { accountContract } from "@shigomori/contracts/modules/account";
import { clientConfigContract } from "@shigomori/contracts/modules/clientConfig";
import { dialogContract } from "@shigomori/contracts/modules/dialog";
import { menuContract } from "@shigomori/contracts/modules/menu";
import { navContract } from "@shigomori/contracts/modules/nav";
import { releasesContract } from "@shigomori/contracts/modules/releases";
import { shellContract } from "@shigomori/contracts/modules/shell";
import { windowContract } from "@shigomori/contracts/modules/window";
import { withoutPeerState } from "@shigomori/contracts/schemas/config";
import { logFailure } from "@shared/log";
import {
  readClientConfigSync,
  writeClientConfig,
} from "../electron/clientConfig";
import { reconcileLaunchAtLogin } from "../electron/liveness";
import { clientConfigHandlers } from "./modules/clientConfig";
import { dialogHandlers } from "./modules/dialog";
import { menuHandlers } from "./modules/menu";
import { navHandlers } from "./modules/nav";
import { releasesHandlers } from "./modules/releases";
import { shellHandlers } from "./modules/shell";
import { windowHandlers } from "./modules/window";
import { host } from "../hostProcess";
import {
  acceptsPeerCommands,
  accountFactsForHost,
  makeAccountHandlers,
} from "./modules/account";
import { broadcastAll, registerContract } from "./register";

export function registerShellHandlers(): void {
  registerContract(clientConfigContract, clientConfigHandlers);
  // The account the client config's peer-keyed state was built under,
  // so a change can tell a rename from a departure. Unknown until the
  // first change: reading it here would open the credential store
  // before app.ready. An unknown previous account leaves one thing
  // certain: a change to signed out is a departure.
  let peerAccountId: string | null | undefined;
  const accountHandlers = makeAccountHandlers(
    async (accountId) => {
      const previous = peerAccountId;
      peerAccountId = accountId;
      const leaving =
        previous === undefined
          ? accountId === null
          : previous !== null && accountId !== previous;
      // Before the windows are told, since they re-read their config
      // off the push.
      if (leaving) {
        await logFailure(
          "[account] dropping the peer-keyed client config failed",
          () => writeClientConfig(withoutPeerState(readClientConfigSync())),
        );
      }
      // The host tears down what was the account's and follows it with
      // the hub socket, while the windows re-read the status.
      const applied = host().account(accountFactsForHost());
      broadcastAll(accountContract, "changed", { accountId });
      // An account switch that stays signed in changes the switch's
      // answer too, which `changed` does not refresh.
      broadcastAll(
        accountContract,
        "commandAccessChanged",
        acceptsPeerCommands(),
      );
      await logFailure(
        "[account] the host's account change failed",
        () => applied,
      );
      // The login item keeps a machine reachable to its account: signed
      // out it comes off, and the next sign-in puts it back.
      if (leaving || previous === null || previous === undefined) {
        reconcileLaunchAtLogin();
      }
    },
    // The switch flipping goes out on its own push, so the toggle does
    // not thrash the account's status and device queries. The host
    // hears it in the facts and tells the peers.
    () => {
      broadcastAll(
        accountContract,
        "commandAccessChanged",
        acceptsPeerCommands(),
      );
      void host().account(accountFactsForHost());
    },
    // The registry as the hub last listed it, which the host's mirrors
    // and forwards follow.
    (devices) =>
      void host().accountDevices(devices.map((device) => device.deviceId)),
  );
  registerContract(accountContract, accountHandlers);
  registerContract(windowContract, windowHandlers);
  registerContract(navContract, navHandlers);
  registerContract(dialogContract, dialogHandlers);
  registerContract(shellContract, shellHandlers);
  registerContract(releasesContract, releasesHandlers);
  registerContract(menuContract, menuHandlers);
}
