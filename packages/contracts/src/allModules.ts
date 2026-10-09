import type { ContractModule } from "./contract.ts";
import { accountContract } from "./modules/account.ts";
import { agentsContract } from "./modules/agents.ts";
import { branchesContract } from "./modules/branches.ts";
import { clientConfigContract } from "./modules/clientConfig.ts";
import { dialogContract } from "./modules/dialog.ts";
import { forwardContract } from "./modules/forward.ts";
import { fsContract } from "./modules/fs.ts";
import { gitContract } from "./modules/git.ts";
import { githubCliContract } from "./modules/githubCli.ts";
import { globalConfigContract } from "./modules/globalConfig.ts";
import { hygieneContract } from "./modules/hygiene.ts";
import { launchersContract } from "./modules/launchers.ts";
import { menuContract } from "./modules/menu.ts";
import { mirrorContract } from "./modules/mirror.ts";
import { navContract } from "./modules/nav.ts";
import { packageScriptsContract } from "./modules/packageScripts.ts";
import { portForwardContract } from "./modules/portForward.ts";
import { portPoolContract } from "./modules/portPool.ts";
import { portsContract } from "./modules/ports.ts";
import { projectsContract } from "./modules/projects.ts";
import { releasesContract } from "./modules/releases.ts";
import { hubContract } from "./modules/hub.ts";
import { runtimeContract } from "./modules/runtime.ts";
import { scriptsContract } from "./modules/scripts.ts";
import { sharedSettingsContract } from "./modules/sharedSettings.ts";
import { sharingContract } from "./modules/sharing.ts";
import { cliContract } from "./modules/cli.ts";
import { shellContract } from "./modules/shell.ts";
import { terrierContract } from "./modules/terrier.ts";
import { shigomoriContract } from "./modules/shigomori.ts";
import { worktreeDataContract } from "./modules/worktreeData.ts";
import { syncContract } from "./modules/sync.ts";
import { updaterContract } from "./modules/updater.ts";
import { villagersContract } from "./modules/villagers.ts";
import { windowContract } from "./modules/window.ts";
import { worktreesContract } from "./modules/worktrees.ts";

// Every contract module the app serves or calls, in one list: the api
// is built from it, the device link's group (link.ts), and a binding
// that needs the full channel inventory (the web bridge's stub fallback
// walks every call to answer unhandled channels with a typed default).
export const allContractModules = [
  accountContract,
  agentsContract,
  branchesContract,
  clientConfigContract,
  dialogContract,
  forwardContract,
  fsContract,
  gitContract,
  githubCliContract,
  globalConfigContract,
  hygieneContract,
  launchersContract,
  menuContract,
  mirrorContract,
  navContract,
  packageScriptsContract,
  portForwardContract,
  portPoolContract,
  portsContract,
  projectsContract,
  releasesContract,
  hubContract,
  runtimeContract,
  scriptsContract,
  sharedSettingsContract,
  sharingContract,
  cliContract,
  shellContract,
  terrierContract,
  shigomoriContract,
  worktreeDataContract,
  syncContract,
  updaterContract,
  villagersContract,
  windowContract,
  worktreesContract,
] as const satisfies readonly ContractModule[];

export type AllContractModule = (typeof allContractModules)[number];
