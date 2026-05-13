// IPC channel names. Keep flat and namespaced by domain.
export const CHANNELS = {
  ProjectsList: "projects:list",
  ProjectsAdd: "projects:add",
  ProjectsRemove: "projects:remove",
  WorktreesList: "worktrees:list",
  DialogPickFolder: "dialog:pickFolder",
} as const;

export type ChannelName = (typeof CHANNELS)[keyof typeof CHANNELS];
