import { buildClient } from "@shared/ipc/buildClient";
import type { ContractModule, ContractScope } from "@shared/ipc/contract";
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
import { navContract } from "@shared/ipc/modules/nav";
import { packageScriptsContract } from "@shared/ipc/modules/packageScripts";
import { portForwardContract } from "@shared/ipc/modules/portForward";
import { portPoolContract } from "@shared/ipc/modules/portPool";
import { portsContract } from "@shared/ipc/modules/ports";
import { projectLauncherContract } from "@shared/ipc/modules/projectLauncher";
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
import type { ClientTransport } from "@shared/ipc/transport";
import type {
  ClientConfig,
  DeviceSettingsPatch,
  GlobalConfig,
  LaunchToolMenuEntry,
  PackageScriptSortMode,
  PickFolderPayload,
  ProjectSortMode,
  ShigomoriConfig,
  ShigomoriWorktreeData,
  SidebarView,
  Theme,
} from "@shared/schemas";

// Every contract module the api surface is built from, in one list, so
// a platform binding that needs the full channel inventory (the web
// bridge's stub fallback walks every def to answer unhandled channels
// with a typed default) reads the same set buildApi consumes instead of
// keeping a second import list that could drift. Kept beside buildApi
// on purpose: adding a module means touching both in this one file.
export const allContractModules: readonly ContractModule[] = [
  accountContract,
  branchesContract,
  clientConfigContract,
  dialogContract,
  directContract,
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
  projectLauncherContract,
  projectsContract,
  hubContract,
  remoteAccessContract,
  runtimeContract,
  scriptsContract,
  cliContract,
  shellContract,
  terrierContract,
  shigomoriContract,
  syncContract,
  updaterContract,
  windowContract,
  worktreesContract,
];

// Ergonomic namespaces over the raw contract clients. Each module's
// scope selects its transport, so the caller wires one transport per
// scope and every contract lands on the right wire. The Electron
// preload passes its IPC bridge for both scopes today. Step 3 swaps the
// host entry for a socket transport and nothing else changes.
export function buildApi(transports: Record<ContractScope, ClientTransport>) {
  const c = <M extends ContractModule>(m: M) =>
    buildClient(m, transports[m.scope]);

  const accountClient = c(accountContract);
  const branchesClient = c(branchesContract);
  const clientConfigClient = c(clientConfigContract);
  const dialogClient = c(dialogContract);
  const forwardClient = c(forwardContract);
  const fsClient = c(fsContract);
  const gitClient = c(gitContract);
  const githubCliClient = c(githubCliContract);
  const globalConfigClient = c(globalConfigContract);
  const hygieneClient = c(hygieneContract);
  const launchersClient = c(launchersContract);
  const menuClient = c(menuContract);
  const mirrorClient = c(mirrorContract);
  const navClient = c(navContract);
  const packageScriptsClient = c(packageScriptsContract);
  const portForwardClient = c(portForwardContract);
  const portPoolClient = c(portPoolContract);
  const portsClient = c(portsContract);
  const projectLauncherClient = c(projectLauncherContract);
  const projectsClient = c(projectsContract);
  const hubClient = c(hubContract);
  const remoteAccessClient = c(remoteAccessContract);
  const runtimeClient = c(runtimeContract);
  const scriptsClient = c(scriptsContract);
  const cliClient = c(cliContract);
  const shellClient = c(shellContract);
  const terrierClient = c(terrierContract);
  const shigomoriClient = c(shigomoriContract);
  const syncClient = c(syncContract);
  const updaterClient = c(updaterContract);
  const windowClient = c(windowContract);
  const worktreesClient = c(worktreesContract);

  return {
    account: {
      status: accountClient.status,
      enroll: accountClient.enroll,
      signOut: accountClient.signOut,
      revokeDevice: accountClient.revokeDevice,
      listDevices: accountClient.listDevices,
      setDeviceName: accountClient.setDeviceName,
      acceptsCommands: accountClient.acceptsCommands,
      setAcceptsCommands: accountClient.setAcceptsCommands,
      onChanged: accountClient.changed,
      onCommandAccessChanged: accountClient.commandAccessChanged,
    },

    branches: {
      create: branchesClient.create,
      rename: branchesClient.rename,
      delete: branchesClient.delete,
    },

    clientConfig: {
      read: clientConfigClient.read,
      write: (config: ClientConfig) => clientConfigClient.write({ config }),
    },

    cli: {
      status: cliClient.status,
      install: cliClient.install,
      uninstall: cliClient.uninstall,
      shellStatus: cliClient.shellStatus,
      shellInstall: cliClient.shellInstall,
      shellUninstall: cliClient.shellUninstall,
    },

    dialog: {
      // Optional-arg ergonomics on top of the contract client. The payload
      // type comes from PickFolderPayloadSchema, so new options never need
      // re-declaring here.
      pickFolder: (options?: PickFolderPayload) =>
        dialogClient.pickFolder(options),
    },

    // The direct contract is deliberately absent
    // here: its one read is the peer-to-peer brokering call the direct
    // dialer invokes over the raw peer transport, and no renderer or
    // local caller has a use for it (locally it answers
    // available:false). It stays in allContractModules above so the
    // wire inventory still carries it.

    forward: {
      open: forwardClient.open,
    },

    fs: {
      listDirectory: (path: string) => fsClient.listDirectory({ path }),
      scanForGitRepos: (path: string) => fsClient.scanForGitRepos({ path }),
      isGitRepo: (path: string) => fsClient.isGitRepo({ path }),
    },

    git: {
      refreshProject: (projectId: string) =>
        gitClient.refreshProject({ projectId }),
      onRefsRefreshed: gitClient.refsRefreshed,
      onFetchActive: gitClient.fetchActive,
      onExternalChange: gitClient.externalChange,
      onProjectChanged: gitClient.projectChanged,
    },

    githubCli: {
      readiness: githubCliClient.readiness,
      projectPullRequests: (projectId: string) =>
        githubCliClient.projectPullRequests({ projectId }),
      worktreePullRequest: githubCliClient.worktreePullRequest,
      pullRequestCandidates: (projectId: string) =>
        githubCliClient.pullRequestCandidates({ projectId }),
      resolvePullRequestCheckout: githubCliClient.resolvePullRequestCheckout,
      repoMergeConfig: (projectId: string) =>
        githubCliClient.repoMergeConfig({ projectId }),
      mergePullRequest: githubCliClient.mergePullRequest,
      pullRequestDiff: githubCliClient.pullRequestDiff,
      setPullRequestDraft: githubCliClient.setPullRequestDraft,
      onProjectPullRequestsRefreshed:
        githubCliClient.projectPullRequestsRefreshed,
    },

    globalConfig: {
      read: globalConfigClient.read,
      // Local unredacted read. Carries remoteDevices and the hosting
      // token, so it is remote false and callers must keep the result
      // out of any broadly-cached query (the registry reconcile and the
      // hosting/remote-device write base read it imperatively).
      readLocal: globalConfigClient.readLocal,
      write: (config: GlobalConfig) => globalConfigClient.write({ config }),
      // The remote-writable device-settings subset: patch semantics,
      // strict schema, structurally unable to carry socketHost or
      // remoteDevices.
      writeDeviceSettings: (patch: DeviceSettingsPatch) =>
        globalConfigClient.writeDeviceSettings({ patch }),
    },

    hygiene: {
      list: (projectId: string) => hygieneClient.list({ projectId }),
      diskUsage: hygieneClient.diskUsage,
    },

    launchers: {
      detect: launchersClient.detect,
      forProject: (projectId: string) =>
        launchersClient.forProject({ projectId }),
      launch: launchersClient.launch,
    },

    menu: {
      setLaunchToolsEnabled: (
        enabled: boolean,
        entries?: LaunchToolMenuEntry[],
      ) => menuClient.setLaunchToolsEnabled({ enabled, entries }),
    },

    nav: {
      onOpenSettings: navClient.openSettings,
      onLaunchById: navClient.launchById,
    },

    packageScripts: {
      list: packageScriptsClient.list,
      run: packageScriptsClient.run,
      getSort: (projectId: string) =>
        packageScriptsClient.getSort({ projectId }),
      setSort: (projectId: string, mode: PackageScriptSortMode) =>
        packageScriptsClient.setSort({ projectId, mode }),
    },

    portForward: {
      start: portForwardClient.start,
      stop: (forwardId: string) => portForwardClient.stop({ forwardId }),
      list: portForwardClient.list,
      onChanged: portForwardClient.changed,
    },

    ports: {
      list: (projectId: string, worktreeId: string) =>
        portsClient.list({ projectId, worktreeId }),
    },

    portPool: {
      isActive: portPoolClient.isActive,
      isInstalled: portPoolClient.isInstalled,
    },

    projectLauncher: {
      onToggle: projectLauncherClient.toggle,
      onAddProject: projectLauncherClient.addProject,
    },

    projects: {
      list: projectsClient.list,
      add: (path: string) => projectsClient.add({ path }),
      remove: (id: string) => projectsClient.remove({ id }),
      reorder: (input: {
        draggedId: string;
        targetId: string;
        position: "before" | "after";
      }) => projectsClient.reorder(input),
      getSort: projectsClient.getSort,
      setSort: (mode: ProjectSortMode) => projectsClient.setSort({ mode }),
      getSidebarView: projectsClient.getSidebarView,
      setSidebarView: (view: SidebarView) =>
        projectsClient.setSidebarView({ view }),
      getCollapsed: projectsClient.getCollapsed,
      toggleCollapsed: (projectId: string) =>
        projectsClient.toggleCollapsed({ projectId }),
      onUsageBumped: projectsClient.usageBumped,
      defaultBranch: (projectId: string) =>
        projectsClient.defaultBranch({ projectId }),
      listBranches: (projectId: string) =>
        projectsClient.listBranches({ projectId }),
      pickWorktreeName: (projectId: string) =>
        projectsClient.pickWorktreeName({ projectId }),
      worktreeIncludeStatus: (projectId: string) =>
        projectsClient.worktreeIncludeStatus({ projectId }),
      carryOverListing: projectsClient.carryOverListing,
      carryOverStats: projectsClient.carryOverStats,
      icon: (projectId: string) => projectsClient.icon({ projectId }),
    },

    hub: {
      status: hubClient.status,
      invokePeer: hubClient.invokePeer,
      onStatusChanged: hubClient.statusChanged,
      onPeerPush: hubClient.peerPush,
    },

    remoteAccess: {
      // The preflight "am I granted command access on this host?" read,
      // answered per calling peer by the serving transport.
      commandAccess: remoteAccessClient.commandAccess,
    },

    runtime: {
      info: runtimeClient.info,
      nuke: runtimeClient.nuke,
      moveRoot: (parentDir: string) => runtimeClient.moveRoot({ parentDir }),
      onNukeProgress: runtimeClient.nukeProgress,
    },

    scripts: {
      run: scriptsClient.run,
      cancel: (runId: string) => scriptsClient.cancel({ runId }),
      orphanReport: scriptsClient.orphanReport,
      onEvent: scriptsClient.event,
      onStoppedForRemovedWorktree: scriptsClient.stoppedForRemovedWorktree,
    },

    shell: {
      openExternal: (url: string) => shellClient.openExternal({ url }),
      showItemInFolder: (path: string) =>
        shellClient.showItemInFolder({ path }),
    },

    mirror: {
      list: mirrorClient.list,
      start: mirrorClient.start,
      stop: (session: string) => mirrorClient.stop({ session }),
      pause: (session: string) => mirrorClient.pause({ session }),
      resume: (session: string) => mirrorClient.resume({ session }),
      onChanged: mirrorClient.changed,
    },

    shigomori: {
      read: (projectId: string) => shigomoriClient.read({ projectId }),
      write: (projectId: string, config: ShigomoriConfig) =>
        shigomoriClient.write({ projectId, config }),
    },

    sync: {
      refTips: syncClient.refTips,
      captureDirty: syncClient.captureDirty,
      bundleStart: syncClient.bundleStart,
      bundleChunk: syncClient.bundleChunk,
      bundleAbort: syncClient.bundleAbort,
      pullWorktree: syncClient.pullWorktree,
      teardownSource: syncClient.teardownSource,
      onPullProgress: syncClient.pullProgress,
    },

    terrier: {
      readiness: terrierClient.readiness,
    },

    updater: {
      get: updaterClient.get,
      check: updaterClient.check,
      install: updaterClient.install,
      onState: updaterClient.state,
    },

    window: {
      onFocused: windowClient.focused,
      onBlurred: windowClient.blurred,
      previewTheme: (theme: Theme) => windowClient.previewTheme({ theme }),
      relaunch: windowClient.relaunch,
    },

    worktreeData: {
      read: (projectId: string, worktreeId: string) =>
        shigomoriClient.worktreeDataRead({ projectId, worktreeId }),
      write: (
        projectId: string,
        worktreeId: string,
        data: ShigomoriWorktreeData,
      ) => shigomoriClient.worktreeDataWrite({ projectId, worktreeId, data }),
    },

    worktrees: {
      list: (projectId: string) => worktreesClient.list({ projectId }),
      create: worktreesClient.create,
      convertExternal: worktreesClient.convertExternal,
      relocate: worktreesClient.relocate,
      delete: worktreesClient.delete,
      onLifecyclePhase: worktreesClient.lifecyclePhase,
      onCarryOverComplete: worktreesClient.carryOverComplete,
      renameBranch: worktreesClient.renameBranch,
      setShelved: worktreesClient.setShelved,
      checkoutBranch: worktreesClient.checkoutBranch,
      diff: worktreesClient.diff,
      commitDiff: worktreesClient.commitDiff,
      listCommits: worktreesClient.listCommits,
      push: worktreesClient.push,
      pull: worktreesClient.pull,
      pushForce: worktreesClient.pushForce,
      overwrite: worktreesClient.overwrite,
      publish: worktreesClient.publish,
      pullAndPush: worktreesClient.pullAndPush,
      syncWithPrimary: worktreesClient.syncWithPrimary,
      switchToPrimaryAndDeleteBranch:
        worktreesClient.switchToPrimaryAndDeleteBranch,
    },
  } as const;
}
