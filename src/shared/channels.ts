// IPC channel names. Keep flat and namespaced by domain.
export const CHANNELS = {
  ProjectsList: "projects:list",
  ProjectsAdd: "projects:add",
  ProjectsRemove: "projects:remove",
  WorktreesList: "worktrees:list",
  WorktreesCreate: "worktrees:create",
  WorktreesDelete: "worktrees:delete",
  ShigotoRead: "shigoto:read",
  LaunchersDetect: "launchers:detect",
  LaunchersForProject: "launchers:forProject",
  LaunchersLaunch: "launchers:launch",
  LaunchersSetPreferred: "launchers:setPreferred",
  DialogPickFolder: "dialog:pickFolder",
} as const;

export type ChannelName = (typeof CHANNELS)[keyof typeof CHANNELS];
