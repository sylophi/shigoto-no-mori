import { buildClient } from "@shared/ipc/buildClient";
import type { ContractModule, ContractScope } from "@shared/ipc/contract";
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
import { navContract } from "@shared/ipc/modules/nav";
import { packageScriptsContract } from "@shared/ipc/modules/packageScripts";
import { portPoolContract } from "@shared/ipc/modules/portPool";
import { projectLauncherContract } from "@shared/ipc/modules/projectLauncher";
import { projectsContract } from "@shared/ipc/modules/projects";
import { relayContract } from "@shared/ipc/modules/relay";
import { runtimeContract } from "@shared/ipc/modules/runtime";
import { scriptsContract } from "@shared/ipc/modules/scripts";
import { cliContract } from "@shared/ipc/modules/cli";
import { shellContract } from "@shared/ipc/modules/shell";
import { shigomoriContract } from "@shared/ipc/modules/shigomori";
import { updaterContract } from "@shared/ipc/modules/updater";
import { windowContract } from "@shared/ipc/modules/window";
import { worktreesContract } from "@shared/ipc/modules/worktrees";
import type { ClientTransport } from "@shared/ipc/transport";
import type {
  ClientConfig,
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
  const fsClient = c(fsContract);
  const gitClient = c(gitContract);
  const githubCliClient = c(githubCliContract);
  const globalConfigClient = c(globalConfigContract);
  const hygieneClient = c(hygieneContract);
  const launchersClient = c(launchersContract);
  const menuClient = c(menuContract);
  const navClient = c(navContract);
  const packageScriptsClient = c(packageScriptsContract);
  const portPoolClient = c(portPoolContract);
  const projectLauncherClient = c(projectLauncherContract);
  const projectsClient = c(projectsContract);
  const relayClient = c(relayContract);
  const runtimeClient = c(runtimeContract);
  const scriptsClient = c(scriptsContract);
  const cliClient = c(cliContract);
  const shellClient = c(shellContract);
  const shigomoriClient = c(shigomoriContract);
  const updaterClient = c(updaterContract);
  const windowClient = c(windowContract);
  const worktreesClient = c(worktreesContract);

  return {
    account: {
      status: accountClient.status,
      signIn: accountClient.signIn,
      signOut: accountClient.signOut,
      listDevices: accountClient.listDevices,
      setDeviceName: accountClient.setDeviceName,
      onChanged: accountClient.changed,
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

    fs: {
      listDirectory: (path: string) => fsClient.listDirectory({ path }),
      scanForGitRepos: (path: string) => fsClient.scanForGitRepos({ path }),
      isGitRepo: (path: string) => fsClient.isGitRepo({ path }),
      stat: (path: string) => fsClient.stat({ path }),
      listEntries: (path: string) => fsClient.listEntries({ path }),
    },

    git: {
      refreshProject: (projectId: string) =>
        gitClient.refreshProject({ projectId }),
      onRefsRefreshed: gitClient.refsRefreshed,
      onFetchActive: gitClient.fetchActive,
      onExternalChange: gitClient.externalChange,
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
      listIgnoredPaths: (projectId: string) =>
        projectsClient.listIgnoredPaths({ projectId }),
      worktreeIncludeStatus: (projectId: string) =>
        projectsClient.worktreeIncludeStatus({ projectId }),
      icon: (projectId: string) => projectsClient.icon({ projectId }),
    },

    relay: {
      status: relayClient.status,
      invokePeer: relayClient.invokePeer,
      peerInfo: relayClient.peerInfo,
      onStatusChanged: relayClient.statusChanged,
      onPeerPush: relayClient.peerPush,
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

    shigomori: {
      read: (projectId: string) => shigomoriClient.read({ projectId }),
      write: (projectId: string, config: ShigomoriConfig) =>
        shigomoriClient.write({ projectId, config }),
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
