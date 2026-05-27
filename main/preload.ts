// Preload script — runs in an isolated context with access to Node + Electron APIs.
// Exposes a typed `window.api` to the renderer.
// https://www.electronjs.org/docs/latest/tutorial/process-model#preload-scripts
import { contextBridge } from "electron";
import { branchesContract } from "@shared/ipc/modules/branches";
import { dialogContract } from "@shared/ipc/modules/dialog";
import { fsContract } from "@shared/ipc/modules/fs";
import { gitContract } from "@shared/ipc/modules/git";
import { githubCliContract } from "@shared/ipc/modules/githubCli";
import { globalConfigContract } from "@shared/ipc/modules/globalConfig";
import { launchersContract } from "@shared/ipc/modules/launchers";
import { menuContract } from "@shared/ipc/modules/menu";
import { navContract } from "@shared/ipc/modules/nav";
import { packageScriptsContract } from "@shared/ipc/modules/packageScripts";
import { paletteContract } from "@shared/ipc/modules/palette";
import { portPoolContract } from "@shared/ipc/modules/portPool";
import { projectsContract } from "@shared/ipc/modules/projects";
import { runtimeContract } from "@shared/ipc/modules/runtime";
import { scriptsContract } from "@shared/ipc/modules/scripts";
import { shellContract } from "@shared/ipc/modules/shell";
import { shigomoriContract } from "@shared/ipc/modules/shigomori";
import { updaterContract } from "@shared/ipc/modules/updater";
import { windowContract } from "@shared/ipc/modules/window";
import { worktreesContract } from "@shared/ipc/modules/worktrees";
import type {
  GlobalConfig,
  LaunchToolMenuEntry,
  PackageScriptSortMode,
  ShigomoriConfig,
  ShigomoriWorktreeData,
  Theme,
} from "@shared/schemas";
import { buildClient } from "./preload/buildClient";

// Preserves the historical scalar-arg renderer API (e.g. `add(path)`)
// while routing through the contract; renderer hooks keep their signatures.
const projectsClient = buildClient(projectsContract);
const dialogClient = buildClient(dialogContract);
const runtimeClient = buildClient(runtimeContract);
const shellClient = buildClient(shellContract);
const branchesClient = buildClient(branchesContract);
const fsClient = buildClient(fsContract);
const gitClient = buildClient(gitContract);
const githubCliClient = buildClient(githubCliContract);
const globalConfigClient = buildClient(globalConfigContract);
const launchersClient = buildClient(launchersContract);
const menuClient = buildClient(menuContract);
const navClient = buildClient(navContract);
const packageScriptsClient = buildClient(packageScriptsContract);
const paletteClient = buildClient(paletteContract);
const portPoolClient = buildClient(portPoolContract);
const scriptsClient = buildClient(scriptsContract);
const shigomoriClient = buildClient(shigomoriContract);
const updaterClient = buildClient(updaterContract);
const windowClient = buildClient(windowContract);
const worktreesClient = buildClient(worktreesContract);

const api = {
  projects: {
    list: () => projectsClient.list(),
    add: (path: string) => projectsClient.add({ path }),
    remove: (id: string) => projectsClient.remove({ id }),
    reorder: (input: {
      draggedId: string;
      targetId: string;
      position: "before" | "after";
    }) => projectsClient.reorder(input),
    defaultBranch: (projectId: string) =>
      projectsClient.defaultBranch({ projectId }),
    listBranches: (projectId: string) =>
      projectsClient.listBranches({ projectId }),
    pickWorktreeName: (projectId: string) =>
      projectsClient.pickWorktreeName({ projectId }),
    listIgnoredPaths: (projectId: string) =>
      projectsClient.listIgnoredPaths({ projectId }),
    icon: (projectId: string) => projectsClient.icon({ projectId }),
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
  },
  branches: {
    create: branchesClient.create,
    rename: branchesClient.rename,
    delete: branchesClient.delete,
  },
  dialog: {
    pickFolder: (options?: { title?: string; buttonLabel?: string }) =>
      dialogClient.pickFolder(options),
  },
  runtime: {
    info: () => runtimeClient.info(),
    setTheme: (theme: Theme) => runtimeClient.setTheme({ theme }),
    nuke: () => runtimeClient.nuke(),
  },
  fs: {
    listDirectory: (path: string) => fsClient.listDirectory({ path }),
    scanForGitRepos: (path: string) => fsClient.scanForGitRepos({ path }),
    isGitRepo: (path: string) => fsClient.isGitRepo({ path }),
    stat: (path: string) => fsClient.stat({ path }),
    listEntries: (path: string) => fsClient.listEntries({ path }),
  },
  shigomori: {
    read: (projectId: string) => shigomoriClient.read({ projectId }),
    write: (projectId: string, config: ShigomoriConfig) =>
      shigomoriClient.write({ projectId, config }),
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
  globalConfig: {
    read: () => globalConfigClient.read(),
    write: (config: GlobalConfig) => globalConfigClient.write({ config }),
  },
  shell: {
    openPath: (path: string) => shellClient.openPath({ path }),
    openExternal: (url: string) => shellClient.openExternal({ url }),
    showItemInFolder: (path: string) => shellClient.showItemInFolder({ path }),
  },
  palette: {
    onToggle: paletteClient.toggle,
    onAddProject: paletteClient.addProject,
  },
  nav: {
    onOpenSettings: navClient.openSettings,
    onLaunchById: navClient.launchById,
  },
  menu: {
    setLaunchToolsEnabled: (
      enabled: boolean,
      entries?: LaunchToolMenuEntry[],
    ) => menuClient.setLaunchToolsEnabled({ enabled, entries }),
  },
  window: {
    onFocused: windowClient.focused,
    onBlurred: windowClient.blurred,
  },
  git: {
    onRefsRefreshed: gitClient.refsRefreshed,
    onFetchActive: gitClient.fetchActive,
  },
  packageScripts: {
    list: packageScriptsClient.list,
    run: packageScriptsClient.run,
    getSort: (projectId: string) => packageScriptsClient.getSort({ projectId }),
    setSort: (projectId: string, mode: PackageScriptSortMode) =>
      packageScriptsClient.setSort({ projectId, mode }),
  },
  portPool: {
    isActive: portPoolClient.isActive,
    isInstalled: () => portPoolClient.isInstalled(),
  },
  githubCli: {
    readiness: () => githubCliClient.readiness(),
    projectPullRequests: githubCliClient.projectPullRequests,
    worktreePullRequest: githubCliClient.worktreePullRequest,
    repoMergeConfig: githubCliClient.repoMergeConfig,
    mergePullRequest: githubCliClient.mergePullRequest,
    pullRequestDiff: githubCliClient.pullRequestDiff,
    setPullRequestDraft: githubCliClient.setPullRequestDraft,
    onProjectPullRequestsRefreshed:
      githubCliClient.projectPullRequestsRefreshed,
  },
  scripts: {
    run: scriptsClient.run,
    cancel: (runId: string) => scriptsClient.cancel({ runId }),
    onEvent: scriptsClient.event,
  },
  updater: {
    get: () => updaterClient.get(),
    check: () => updaterClient.check(),
    install: () => updaterClient.install(),
    onState: updaterClient.state,
  },
  launchers: {
    detected: () => launchersClient.detect(),
    forProject: (projectId: string) =>
      launchersClient.forProject({ projectId }),
    launch: launchersClient.launch,
  },
} as const;

export type RendererApi = typeof api;

contextBridge.exposeInMainWorld("api", api);
