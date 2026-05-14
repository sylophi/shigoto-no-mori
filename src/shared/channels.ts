// IPC channel names. Keep flat and namespaced by domain.
export const CHANNELS = {
  ProjectsList: "projects:list",
  ProjectsAdd: "projects:add",
  ProjectsRemove: "projects:remove",
  ProjectsDefaultBranch: "projects:defaultBranch",
  ProjectsListBranches: "projects:listBranches",
  ProjectsPickWorktreeName: "projects:pickWorktreeName",
  ProjectsListIgnoredPaths: "projects:listIgnoredPaths",
  WorktreesList: "worktrees:list",
  WorktreesCreate: "worktrees:create",
  WorktreesDelete: "worktrees:delete",
  WorktreesRenameBranch: "worktrees:renameBranch",
  WorktreesCheckoutBranch: "worktrees:checkoutBranch",
  BranchesCreate: "branches:create",
  BranchesRename: "branches:rename",
  BranchesDelete: "branches:delete",
  ShigomoriRead: "shigomori:read",
  ScriptsRun: "scripts:run",
  ScriptsCancel: "scripts:cancel",
  ScriptsEvent: "scripts:event",
  LaunchersDetect: "launchers:detect",
  LaunchersForProject: "launchers:forProject",
  LaunchersLaunch: "launchers:launch",
  DialogPickFolder: "dialog:pickFolder",
  RuntimeInfo: "runtime:info",
  RuntimeSetTheme: "runtime:setTheme",
  RuntimeNuke: "runtime:nuke",
  FsListDirectory: "fs:listDirectory",
  FsScanForGitRepos: "fs:scanForGitRepos",
  FsIsGitRepo: "fs:isGitRepo",
  FsStat: "fs:stat",
  FsListEntries: "fs:listEntries",
  ShigomoriWrite: "shigomori:write",
  GlobalConfigRead: "globalConfig:read",
  GlobalConfigWrite: "globalConfig:write",
  ShellOpenPath: "shell:openPath",
  ShellShowItemInFolder: "shell:showItemInFolder",
  PaletteToggle: "palette:toggle",
  PaletteAddProject: "palette:addProject",
  WindowFocused: "window:focused",
  WindowBlurred: "window:blurred",
} as const;

export interface RuntimeInfo {
  shigomoriRoot: string;
  homedir: string;
  isDev: boolean;
}

export type ChannelName = (typeof CHANNELS)[keyof typeof CHANNELS];
