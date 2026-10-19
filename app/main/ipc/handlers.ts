// Every handler the shell serves its windows, assembled and registered
// in registerShellHandlers, once at boot: the client modules whose
// state is this machine as Electron sees it. The host's are
// host/process/handlers.ts. The account is the shell's (its credential
// is in the keychain), and every change to it is reported to the host,
// which runs the hub socket and the peer-facing state it gates.
import * as Effect from "effect/Effect";
import { accountContract } from "@shigomori/contracts/modules/account";
import { clientConfigContract } from "@shigomori/contracts/modules/clientConfig";
import { dialogContract } from "@shigomori/contracts/modules/dialog";
import { guideContract } from "@shigomori/contracts/modules/guide";
import { menuContract } from "@shigomori/contracts/modules/menu";
import { migrationContract } from "@shigomori/contracts/modules/migration";
import { navContract } from "@shigomori/contracts/modules/nav";
import { releasesContract } from "@shigomori/contracts/modules/releases";
import { shellContract } from "@shigomori/contracts/modules/shell";
import { windowContract } from "@shigomori/contracts/modules/window";
import {
  departed,
  withoutPeerState,
} from "@shigomori/contracts/schemas/config";
import { warnOnFailure } from "@shared/log";
import { updateClientConfig } from "../electron/clientConfig";
import { reconcileLaunchAtLogin } from "../electron/liveness";
import {
  clientConfigHandlers,
  clientConfigViews,
} from "./modules/clientConfig";
import { dialogHandlers } from "./modules/dialog";
import { guideHandlers } from "./modules/guide";
import { menuHandlers } from "./modules/menu";
import { migrationHandlers } from "./modules/migration";
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
import { broadcastAll, registerContract, registerViews } from "./register";

export function registerShellHandlers(): void {
  registerContract(clientConfigContract, clientConfigHandlers);
  registerViews(clientConfigContract, clientConfigViews);
  const accountHandlers = makeAccountHandlers({
    changed: async ({ before, after }) => {
      // Before the windows are told, since they re-read their config
      // off the push.
      if (departed({ before, after })) {
        await warnOnFailure(
          "[account] dropping the peer-keyed client config failed",
          () => updateClientConfig(withoutPeerState),
        );
      }
      // The host tears down what was the account's and follows it with
      // the hub socket, while the windows re-read the status.
      const applied = Effect.runPromise(host().account(accountFactsForHost()));
      broadcastAll(accountContract, "changed", { accountId: after });
      // An account switch that stays signed in changes the switch's
      // answer too, which `changed` does not refresh.
      broadcastAll(
        accountContract,
        "commandAccessChanged",
        acceptsPeerCommands(),
      );
      await warnOnFailure(
        "[account] the host's account change failed",
        () => applied,
      );
      // The login item keeps a machine reachable to its account: signed
      // out it comes off, and the next sign-in puts it back.
      if (before !== after) reconcileLaunchAtLogin();
    },
    // The switch flipping goes out on its own push, so the toggle does
    // not thrash the account's status and device queries. The host
    // hears it in the facts and tells the peers.
    commandAccessChanged: () => {
      broadcastAll(
        accountContract,
        "commandAccessChanged",
        acceptsPeerCommands(),
      );
      Effect.runFork(Effect.ignore(host().account(accountFactsForHost())));
    },
    // The registry as the hub last listed it, which the host's mirrors
    // and forwards follow.
    devicesListed: (devices) =>
      void Effect.runFork(
        Effect.ignore(
          host().accountDevices(devices.map((device) => device.deviceId)),
        ),
      ),
  });
  registerContract(accountContract, accountHandlers);
  registerContract(windowContract, windowHandlers);
  registerContract(navContract, navHandlers);
  registerContract(migrationContract, migrationHandlers);
  registerContract(dialogContract, dialogHandlers);
  registerContract(shellContract, shellHandlers);
  registerContract(releasesContract, releasesHandlers);
  registerContract(menuContract, menuHandlers);
  registerContract(guideContract, guideHandlers);
}
