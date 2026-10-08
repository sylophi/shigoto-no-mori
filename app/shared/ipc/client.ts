import { buildClient } from "@shared/ipc/buildClient";
import {
  type ContractModule,
  type ContractScope,
  nameOf,
  scopeOf,
} from "@shigomori/contracts/contract";
import type {
  Api,
  ChannelHandlers,
  HostApiOf,
} from "@shigomori/contracts/types";
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
import { mirrorContract } from "@shigomori/contracts/modules/mirror";
import { navContract } from "@shigomori/contracts/modules/nav";
import { packageScriptsContract } from "@shigomori/contracts/modules/packageScripts";
import { portForwardContract } from "@shigomori/contracts/modules/portForward";
import { portPoolContract } from "@shigomori/contracts/modules/portPool";
import { portsContract } from "@shigomori/contracts/modules/ports";
import { projectsContract } from "@shigomori/contracts/modules/projects";
import { releasesContract } from "@shigomori/contracts/modules/releases";
import { hubContract } from "@shigomori/contracts/modules/hub";
import { runtimeContract } from "@shigomori/contracts/modules/runtime";
import { scriptsContract } from "@shigomori/contracts/modules/scripts";
import { sharedSettingsContract } from "@shigomori/contracts/modules/sharedSettings";
import { cliContract } from "@shigomori/contracts/modules/cli";
import { shellContract } from "@shigomori/contracts/modules/shell";
import { terrierContract } from "@shigomori/contracts/modules/terrier";
import { shigomoriContract } from "@shigomori/contracts/modules/shigomori";
import { worktreeDataContract } from "@shigomori/contracts/modules/worktreeData";
import { syncContract } from "@shigomori/contracts/modules/sync";
import { updaterContract } from "@shigomori/contracts/modules/updater";
import { villagersContract } from "@shigomori/contracts/modules/villagers";
import { windowContract } from "@shigomori/contracts/modules/window";
import { worktreesContract } from "@shigomori/contracts/modules/worktrees";
import type { ClientTransport } from "@shared/ipc/transport";

// Every contract module the api is built from, in one list, which a
// binding that needs the full channel inventory (the web bridge's stub
// fallback walks every call to answer unhandled channels with a typed
// default) reads too.
export const allContractModules = [
  accountContract,
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

type AllContractModule = (typeof allContractModules)[number];

// A table answering any channel of any module above, typed by the
// contracts: the fake host's fixture handlers.
export type AllChannelHandlers = Partial<ChannelHandlers<AllContractModule>>;

// The api: one namespace per module above, named for it, each the
// module's client on the transport its scope is wired to. The caller
// wires one transport per scope: the Electron preload's bridge carries
// both (host and client live in one process there), the web client
// passes its loopback wires.
export type RendererContractApi = Api<AllContractModule>;

export function buildApi(
  transports: Record<ContractScope, ClientTransport>,
): RendererContractApi {
  const api: Record<string, unknown> = {};
  for (const module of allContractModules) {
    api[nameOf(module)] = buildClient(module, transports[scopeOf(module)]);
  }
  return api as RendererContractApi;
}

// The host-scoped slice of the api: what a device serves, so window.api
// and a connected remote device's api both satisfy it.
export type HostApi = HostApiOf<AllContractModule>;
