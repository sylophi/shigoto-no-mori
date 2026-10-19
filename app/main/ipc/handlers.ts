// Every handler the shell serves its windows, assembled and registered
// in registerShellHandlers, once at boot: the client modules whose
// state is this machine as Electron sees it. The host's are
// host/process/handlers.ts.
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
import { accountHandlers } from "./modules/account";
import { registerContract, registerViews } from "./register";

export function registerShellHandlers(): void {
  registerContract(clientConfigContract, clientConfigHandlers);
  registerViews(clientConfigContract, clientConfigViews);
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
