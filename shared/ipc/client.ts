import { buildClient } from "@shared/ipc/buildClient";
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
import { portPoolContract } from "@shared/ipc/modules/portPool";
import { projectLauncherContract } from "@shared/ipc/modules/projectLauncher";
import { projectsContract } from "@shared/ipc/modules/projects";
import { runtimeContract } from "@shared/ipc/modules/runtime";
import { scriptsContract } from "@shared/ipc/modules/scripts";
import { cliContract } from "@shared/ipc/modules/cli";
import { shellContract } from "@shared/ipc/modules/shell";
import { shigomoriContract } from "@shared/ipc/modules/shigomori";
import { updaterContract } from "@shared/ipc/modules/updater";
import { windowContract } from "@shared/ipc/modules/window";
import { worktreesContract } from "@shared/ipc/modules/worktrees";
import type {
  GlobalConfig,
  LaunchToolMenuEntry,
  PackageScriptSortMode,
  ProjectSortMode,
  ShigomoriConfig,
  ShigomoriWorktreeData,
  Theme,
} from "@shared/schemas";

const branchesClient = buildClient(branchesContract);
const dialogClient = buildClient(dialogContract);
const fsClient = buildClient(fsContract);
const gitClient = buildClient(gitContract);
const githubCliClient = buildClient(githubCliContract);
const globalConfigClient = buildClient(globalConfigContract);
const launchersClient = buildClient(launchersContract);
const menuClient = buildClient(menuContract);
const navClient = buildClient(navContract);
const packageScriptsClient = buildClient(packageScriptsContract);
const portPoolClient = buildClient(portPoolContract);
const projectLauncherClient = buildClient(projectLauncherContract);
const projectsClient = buildClient(projectsContract);
const runtimeClient = buildClient(runtimeContract);
const scriptsClient = buildClient(scriptsContract);
const cliClient = buildClient(cliContract);
const shellClient = buildClient(shellContract);
const shigomoriClient = buildClient(shigomoriContract);
const updaterClient = buildClient(updaterContract);
const windowClient = buildClient(windowContract);
const worktreesClient = buildClient(worktreesContract);

export const branches = {
  create: branchesClient.create,
  rename: branchesClient.rename,
  delete: branchesClient.delete,
} as const;

export const dialog = {
  pickFolder: (options?: { title?: string; buttonLabel?: string }) =>
    dialogClient.pickFolder(options),
} as const;

export const fs = {
  listDirectory: (path: string) => fsClient.listDirectory({ path }),
  scanForGitRepos: (path: string) => fsClient.scanForGitRepos({ path }),
  isGitRepo: (path: string) => fsClient.isGitRepo({ path }),
  stat: (path: string) => fsClient.stat({ path }),
  listEntries: (path: string) => fsClient.listEntries({ path }),
} as const;

export const git = {
  refreshProject: (projectId: string) =>
    gitClient.refreshProject({ projectId }),
  onRefsRefreshed: gitClient.refsRefreshed,
  onFetchActive: gitClient.fetchActive,
  onExternalChange: gitClient.externalChange,
} as const;

export const githubCli = {
  readiness: githubCliClient.readiness,
  projectPullRequests: (projectId: string) =>
    githubCliClient.projectPullRequests({ projectId }),
  worktreePullRequest: githubCliClient.worktreePullRequest,
  repoMergeConfig: (projectId: string) =>
    githubCliClient.repoMergeConfig({ projectId }),
  mergePullRequest: githubCliClient.mergePullRequest,
  pullRequestDiff: githubCliClient.pullRequestDiff,
  setPullRequestDraft: githubCliClient.setPullRequestDraft,
  onProjectPullRequestsRefreshed: githubCliClient.projectPullRequestsRefreshed,
} as const;

export const globalConfig = {
  read: globalConfigClient.read,
  write: (config: GlobalConfig) => globalConfigClient.write({ config }),
} as const;

export const launchers = {
  detect: launchersClient.detect,
  forProject: (projectId: string) => launchersClient.forProject({ projectId }),
  launch: launchersClient.launch,
} as const;

export const menu = {
  setLaunchToolsEnabled: (enabled: boolean, entries?: LaunchToolMenuEntry[]) =>
    menuClient.setLaunchToolsEnabled({ enabled, entries }),
} as const;

export const nav = {
  onOpenSettings: navClient.openSettings,
  onLaunchById: navClient.launchById,
} as const;

export const packageScripts = {
  list: packageScriptsClient.list,
  run: packageScriptsClient.run,
  getSort: (projectId: string) => packageScriptsClient.getSort({ projectId }),
  setSort: (projectId: string, mode: PackageScriptSortMode) =>
    packageScriptsClient.setSort({ projectId, mode }),
} as const;

export const portPool = {
  isActive: portPoolClient.isActive,
  isInstalled: portPoolClient.isInstalled,
} as const;

export const projectLauncher = {
  onToggle: projectLauncherClient.toggle,
  onAddProject: projectLauncherClient.addProject,
} as const;

export const projects = {
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
} as const;

export const runtime = {
  info: runtimeClient.info,
  setTheme: (theme: Theme) => runtimeClient.setTheme({ theme }),
  setDoubutsu: (enabled: boolean) => runtimeClient.setDoubutsu({ enabled }),
  nuke: runtimeClient.nuke,
  onNukeProgress: runtimeClient.nukeProgress,
} as const;

export const scripts = {
  run: scriptsClient.run,
  cancel: (runId: string) => scriptsClient.cancel({ runId }),
  onEvent: scriptsClient.event,
} as const;

export const cli = {
  status: cliClient.status,
  install: cliClient.install,
  uninstall: cliClient.uninstall,
} as const;

export const shell = {
  openPath: (path: string) => shellClient.openPath({ path }),
  openExternal: (url: string) => shellClient.openExternal({ url }),
  showItemInFolder: (path: string) => shellClient.showItemInFolder({ path }),
} as const;

export const shigomori = {
  read: (projectId: string) => shigomoriClient.read({ projectId }),
  write: (projectId: string, config: ShigomoriConfig) =>
    shigomoriClient.write({ projectId, config }),
} as const;

export const worktreeData = {
  read: (projectId: string, worktreeId: string) =>
    shigomoriClient.worktreeDataRead({ projectId, worktreeId }),
  write: (projectId: string, worktreeId: string, data: ShigomoriWorktreeData) =>
    shigomoriClient.worktreeDataWrite({ projectId, worktreeId, data }),
} as const;

export const updater = {
  get: updaterClient.get,
  check: updaterClient.check,
  install: updaterClient.install,
  onState: updaterClient.state,
} as const;

export const windowApi = {
  onFocused: windowClient.focused,
  onBlurred: windowClient.blurred,
} as const;

export const worktrees = {
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
} as const;
