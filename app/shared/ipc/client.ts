import { buildClient } from "@shared/ipc/buildClient";
import {
  type ContractModule,
  type ContractScope,
  scopeOf,
} from "@shigomori/contracts/contract";
import type { ChannelHandlers } from "@shigomori/contracts/types";
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
import type {
  ClientConfig,
  DeviceSettingsPatch,
  LaunchToolMenuEntry,
  PackageScriptSortMode,
  PickFolderPayload,
  SharedSettingsDoc,
  SharedSettingValue,
  ShigomoriConfig,
  ShigomoriWorktreeData,
  Theme,
} from "@shigomori/contracts/schemas";

// Every contract module the api surface is built from, in one list, so
// a platform binding that needs the full channel inventory (the web
// bridge's stub fallback walks every call to answer unhandled channels
// with a typed default) reads the same set buildApi consumes instead of
// keeping a second import list that could drift. Kept beside buildApi
// on purpose: adding a module means touching both in this one file.
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

// A table answering any channel of any module above, typed by the
// contracts: the fake host's fixture handlers.
export type AllChannelHandlers = Partial<
  ChannelHandlers<(typeof allContractModules)[number]>
>;

// Ergonomic namespaces over the raw contract clients. Each module's
// scope selects its transport, so the caller wires one transport per
// scope and every contract lands on the right wire. The Electron
// preload passes its IPC bridge for both scopes (host and client live
// in one process there); the web client passes its loopback wires.
export function buildApi(transports: Record<ContractScope, ClientTransport>) {
  const c = <M extends ContractModule>(m: M) =>
    buildClient(m, transports[scopeOf(m)]);

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
  const projectsClient = c(projectsContract);
  const releasesClient = c(releasesContract);
  const hubClient = c(hubContract);
  const runtimeClient = c(runtimeContract);
  const scriptsClient = c(scriptsContract);
  const sharedSettingsClient = c(sharedSettingsContract);
  const cliClient = c(cliContract);
  const shellClient = c(shellContract);
  const terrierClient = c(terrierContract);
  const shigomoriClient = c(shigomoriContract);
  const worktreeDataClient = c(worktreeDataContract);
  const syncClient = c(syncContract);
  const updaterClient = c(updaterContract);
  const villagersClient = c(villagersContract);
  const windowClient = c(windowContract);
  const worktreesClient = c(worktreesContract);

  // A namespace whose contract's calls all keep their names (no
  // payload ergonomics, no on- prefix) spreads its contract client.
  return {
    account: {
      status: accountClient.status,
      enroll: accountClient.enroll,
      signOut: accountClient.signOut,
      revokeDevice: accountClient.revokeDevice,
      listDevices: accountClient.listDevices,
      setDeviceName: accountClient.setDeviceName,
      setDeviceIcon: accountClient.setDeviceIcon,
      acceptsCommands: accountClient.acceptsCommands,
      setAcceptsCommands: accountClient.setAcceptsCommands,
      onChanged: accountClient.changed,
      onCommandAccessChanged: accountClient.commandAccessChanged,
    },

    branches: { ...branchesClient },

    clientConfig: {
      read: clientConfigClient.read,
      write: (config: ClientConfig) => clientConfigClient.write({ config }),
    },

    cli: { ...cliClient },

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

    forward: { ...forwardClient },

    fs: {
      listDirectory: (path: string) => fsClient.listDirectory({ path }),
      scanForGitRepos: (path: string) => fsClient.scanForGitRepos({ path }),
      isGitRepo: (path: string) => fsClient.isGitRepo({ path }),
    },

    git: {
      refreshProject: (projectId: string) =>
        gitClient.refreshProject({ projectId }),
      sweep: () => gitClient.sweep(),
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
      repoDescription: (projectId: string) =>
        githubCliClient.repoDescription({ projectId }),
      mergePullRequest: githubCliClient.mergePullRequest,
      pullRequestDiff: githubCliClient.pullRequestDiff,
      setPullRequestDraft: githubCliClient.setPullRequestDraft,
      disablePullRequestAutoMerge: githubCliClient.disablePullRequestAutoMerge,
      onProjectPullRequestsRefreshed:
        githubCliClient.projectPullRequestsRefreshed,
    },

    globalConfig: {
      read: globalConfigClient.read,
      // The one settings write, local or remote: patch semantics,
      // strict schema, structurally unable to carry an unmanaged key.
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
      onAddProject: navClient.addProject,
      onLaunchById: navClient.launchById,
      onDeepLink: navClient.deepLink,
      takeDeepLink: navClient.takeDeepLink,
    },

    packageScripts: {
      list: packageScriptsClient.list,
      run: packageScriptsClient.run,
      getSort: (projectId: string) =>
        packageScriptsClient.getSort({ projectId, knowsManual: true }),
      setSort: (projectId: string, mode: PackageScriptSortMode) =>
        packageScriptsClient.setSort({ projectId, mode }),
      getOrder: (projectId: string) =>
        packageScriptsClient.getOrder({ projectId }),
      setOrder: (projectId: string, arranged: string[]) =>
        packageScriptsClient.setOrder({ projectId, arranged }),
      setLaunchRow: (projectId: string, scriptName: string, onRow: boolean) =>
        packageScriptsClient.setLaunchRow({ projectId, scriptName, onRow }),
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

    portPool: { ...portPoolClient },

    projects: {
      list: projectsClient.list,
      add: (path: string) => projectsClient.add({ path }),
      clone: projectsClient.clone,
      remove: (id: string) => projectsClient.remove({ id }),
      relocate: (id: string, path: string) =>
        projectsClient.relocate({ id, path }),
      reorder: (input: {
        draggedId: string;
        targetId: string;
        position: "before" | "after";
      }) => projectsClient.reorder(input),
      onUsageBumped: projectsClient.usageBumped,
      defaultBranch: (projectId: string) =>
        projectsClient.defaultBranch({ projectId }),
      cloneUrl: (projectId: string) => projectsClient.cloneUrl({ projectId }),
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

    releases: { ...releasesClient },

    hub: {
      status: hubClient.status,
      invokePeer: hubClient.invokePeer,
      onStatusChanged: hubClient.statusChanged,
      onPeerPush: hubClient.peerPush,
    },

    runtime: {
      info: runtimeClient.info,
      nuke: runtimeClient.nuke,
      moveDataDir: (parentDir?: string) =>
        runtimeClient.moveDataDir({ parentDir }),
      onNukeProgress: runtimeClient.nukeProgress,
    },

    scripts: {
      run: scriptsClient.run,
      cancel: (runId: string) => scriptsClient.cancel({ runId }),
      write: (runId: string, data: string) =>
        scriptsClient.write({ runId, data }),
      resize: (runId: string, cols: number, rows: number) =>
        scriptsClient.resize({ runId, cols, rows }),
      orphanReport: scriptsClient.orphanReport,
      list: scriptsClient.list,
      onChanged: scriptsClient.changed,
      attach: (runId: string) => scriptsClient.attach({ runId }),
      onEvent: scriptsClient.event,
      onStoppedForRemovedWorktree: scriptsClient.stoppedForRemovedWorktree,
    },

    sharedSettings: {
      read: sharedSettingsClient.read,
      set: (key: string, value: SharedSettingValue) =>
        sharedSettingsClient.set({ key, value }),
      merge: (doc: SharedSettingsDoc) => sharedSettingsClient.merge({ doc }),
      onChanged: sharedSettingsClient.changed,
    },

    shell: {
      openExternal: (url: string) => shellClient.openExternal({ url }),
      showItemInFolder: (path: string) =>
        shellClient.showItemInFolder({ path }),
    },

    mirror: {
      list: mirrorClient.list,
      startTo: mirrorClient.startTo,
      startFrom: mirrorClient.startFrom,
      // `force` discards a copy the peer is not confirmed to hold.
      // Answers whether the copy went (a runner that predates the
      // answer sends nothing, which it did).
      stop: (session: string, force?: boolean) =>
        mirrorClient.stop({ session, force }),
      pause: (session: string) => mirrorClient.pause({ session }),
      resume: (session: string) => mirrorClient.resume({ session }),
      setIgnores: mirrorClient.setIgnores,
      history: mirrorClient.history,
      onChanged: mirrorClient.changed,
    },

    shigomori: {
      read: (projectId: string) => shigomoriClient.read({ projectId }),
      write: (projectId: string, config: ShigomoriConfig) =>
        shigomoriClient.write({ projectId, config }),
    },

    sync: {
      ignoredPaths: syncClient.ignoredPaths,
      worktreeFolder: syncClient.worktreeFolder,
      pullWorktree: syncClient.pullWorktree,
      sendWorktree: syncClient.sendWorktree,
      cancelMove: syncClient.cancelMove,
      teardownSource: syncClient.teardownSource,
      onPullProgress: syncClient.pullProgress,
    },

    terrier: { ...terrierClient },

    updater: {
      get: updaterClient.get,
      check: updaterClient.check,
      install: updaterClient.install,
      update: updaterClient.update,
      onState: updaterClient.state,
    },

    villagers: {
      status: villagersClient.status,
      download: villagersClient.download,
      cancel: villagersClient.cancel,
      remove: villagersClient.remove,
      face: (slug: string) => villagersClient.face({ slug }),
      profiles: villagersClient.profiles,
    },

    window: {
      onFocused: windowClient.focused,
      onBlurred: windowClient.blurred,
      previewTheme: (theme: Theme) => windowClient.previewTheme({ theme }),
      relaunch: windowClient.relaunch,
    },

    worktreeData: {
      read: (projectId: string, worktreeId: string) =>
        worktreeDataClient.read({ projectId, worktreeId }),
      write: (
        projectId: string,
        worktreeId: string,
        data: Pick<ShigomoriWorktreeData, "ports">,
      ) => worktreeDataClient.write({ projectId, worktreeId, data }),
    },

    worktrees: {
      list: (projectId: string) => worktreesClient.list({ projectId }),
      create: worktreesClient.create,
      convertExternal: worktreesClient.convertExternal,
      relocate: worktreesClient.relocate,
      delete: worktreesClient.delete,
      deleteStack: worktreesClient.deleteStack,
      onLifecyclePhase: worktreesClient.lifecyclePhase,
      onCarryOverComplete: worktreesClient.carryOverComplete,
      onRemoval: worktreesClient.removal,
      renameBranch: worktreesClient.renameBranch,
      setShelved: worktreesClient.setShelved,
      setAutoPull: worktreesClient.setAutoPull,
      checkoutBranch: worktreesClient.checkoutBranch,
      fileDiff: worktreesClient.fileDiff,
      readFile: worktreesClient.readFile,
      changeStatus: worktreesClient.changeStatus,
      setStaged: worktreesClient.setStaged,
      commit: worktreesClient.commit,
      discardChanges: worktreesClient.discardChanges,
      restoreDiscard: worktreesClient.restoreDiscard,
      commitMessage: worktreesClient.commitMessage,
      resetSoft: worktreesClient.resetSoft,
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
