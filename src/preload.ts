// Preload script — runs in an isolated context with access to Node + Electron APIs.
// Exposes a typed `window.api` to the renderer.
// https://www.electronjs.org/docs/latest/tutorial/process-model#preload-scripts
import { contextBridge, ipcRenderer } from "electron";
import { CHANNELS } from "@shared/channels";
import type { Project, Worktree } from "@shared/schemas";

const api = {
  projects: {
    list: (): Promise<Project[]> => ipcRenderer.invoke(CHANNELS.ProjectsList),
    add: (path: string): Promise<Project> =>
      ipcRenderer.invoke(CHANNELS.ProjectsAdd, { path }),
    remove: (id: string): Promise<void> =>
      ipcRenderer.invoke(CHANNELS.ProjectsRemove, { id }),
  },
  worktrees: {
    list: (projectId: string): Promise<Worktree[]> =>
      ipcRenderer.invoke(CHANNELS.WorktreesList, { projectId }),
    create: (input: {
      projectId: string;
      branchName: string;
      base?: string;
    }): Promise<Worktree> =>
      ipcRenderer.invoke(CHANNELS.WorktreesCreate, input),
    delete: (input: {
      projectId: string;
      worktreeId: string;
      force?: boolean;
    }): Promise<void> =>
      ipcRenderer.invoke(CHANNELS.WorktreesDelete, {
        ...input,
        force: input.force ?? false,
      }),
  },
  dialog: {
    pickFolder: (): Promise<string | null> =>
      ipcRenderer.invoke(CHANNELS.DialogPickFolder),
  },
} as const;

export type RendererApi = typeof api;

contextBridge.exposeInMainWorld("api", api);
