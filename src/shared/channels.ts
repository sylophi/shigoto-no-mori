// IPC channel names. Keep flat and namespaced by domain.
export const CHANNELS = {
  ProjectsList: "projects:list",
  ProjectsAdd: "projects:add",
  ProjectsRemove: "projects:remove",
  ProjectsDefaultBranch: "projects:defaultBranch",
  WorktreesList: "worktrees:list",
  WorktreesCreate: "worktrees:create",
  WorktreesDelete: "worktrees:delete",
  ShigotoRead: "shigoto:read",
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
  ShigotoWrite: "shigoto:write",
  GlobalConfigRead: "globalConfig:read",
  GlobalConfigWrite: "globalConfig:write",
  ShellOpenPath: "shell:openPath",
  ShellShowItemInFolder: "shell:showItemInFolder",
} as const;

export interface RuntimeInfo {
  shigomoriRoot: string;
  homedir: string;
  isDev: boolean;
}

export type ChannelName = (typeof CHANNELS)[keyof typeof CHANNELS];
