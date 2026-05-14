// Preload script — runs in an isolated context with access to Node + Electron APIs.
// Exposes a typed `window.api` to the renderer.
// https://www.electronjs.org/docs/latest/tutorial/process-model#preload-scripts
import { contextBridge, ipcRenderer } from "electron";
import { CHANNELS, type RuntimeInfo } from "@shared/channels";
import type {
  BranchList,
  CommitSummary,
  DetectedLauncher,
  DirectoryListing,
  GlobalConfig,
  LauncherEntry,
  Project,
  ScriptEvent,
  ScriptName,
  ShigotoConfig,
  Theme,
  Worktree,
} from "@shared/schemas";

const api = {
  projects: {
    list: (): Promise<Project[]> => ipcRenderer.invoke(CHANNELS.ProjectsList),
    add: (path: string): Promise<Project> =>
      ipcRenderer.invoke(CHANNELS.ProjectsAdd, { path }),
    remove: (id: string): Promise<void> =>
      ipcRenderer.invoke(CHANNELS.ProjectsRemove, { id }),
    defaultBranch: (projectId: string): Promise<string> =>
      ipcRenderer.invoke(CHANNELS.ProjectsDefaultBranch, { projectId }),
    listBranches: (projectId: string): Promise<BranchList> =>
      ipcRenderer.invoke(CHANNELS.ProjectsListBranches, { projectId }),
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
    renameBranch: (input: {
      projectId: string;
      worktreeId: string;
      newBranch: string;
    }): Promise<Worktree> =>
      ipcRenderer.invoke(CHANNELS.WorktreesRenameBranch, input),
    checkoutBranch: (input: {
      projectId: string;
      worktreeId: string;
      branch: string;
    }): Promise<Worktree> =>
      ipcRenderer.invoke(CHANNELS.WorktreesCheckoutBranch, input),
    commitHistory: (input: {
      projectId: string;
      worktreeId: string;
      limit?: number;
    }): Promise<CommitSummary[]> =>
      ipcRenderer.invoke(CHANNELS.WorktreesCommitHistory, {
        ...input,
        limit: input.limit ?? 30,
      }),
  },
  dialog: {
    pickFolder: (): Promise<string | null> =>
      ipcRenderer.invoke(CHANNELS.DialogPickFolder),
  },
  runtime: {
    info: (): Promise<RuntimeInfo> => ipcRenderer.invoke(CHANNELS.RuntimeInfo),
    setTheme: (theme: Theme): Promise<void> =>
      ipcRenderer.invoke(CHANNELS.RuntimeSetTheme, { theme }),
    nuke: (): Promise<void> => ipcRenderer.invoke(CHANNELS.RuntimeNuke),
  },
  fs: {
    listDirectory: (path: string): Promise<DirectoryListing> =>
      ipcRenderer.invoke(CHANNELS.FsListDirectory, { path }),
    scanForGitRepos: (path: string): Promise<string[]> =>
      ipcRenderer.invoke(CHANNELS.FsScanForGitRepos, { path }),
    isGitRepo: (path: string): Promise<boolean> =>
      ipcRenderer.invoke(CHANNELS.FsIsGitRepo, { path }),
  },
  shigoto: {
    read: (projectId: string): Promise<ShigotoConfig | null> =>
      ipcRenderer.invoke(CHANNELS.ShigotoRead, { projectId }),
    write: (projectId: string, config: ShigotoConfig): Promise<void> =>
      ipcRenderer.invoke(CHANNELS.ShigotoWrite, { projectId, config }),
  },
  globalConfig: {
    read: (): Promise<GlobalConfig> =>
      ipcRenderer.invoke(CHANNELS.GlobalConfigRead),
    write: (config: GlobalConfig): Promise<void> =>
      ipcRenderer.invoke(CHANNELS.GlobalConfigWrite, { config }),
  },
  shell: {
    openPath: (path: string): Promise<void> =>
      ipcRenderer.invoke(CHANNELS.ShellOpenPath, { path }),
    showItemInFolder: (path: string): Promise<void> =>
      ipcRenderer.invoke(CHANNELS.ShellShowItemInFolder, { path }),
  },
  palette: {
    onToggle: (handler: () => void): (() => void) => {
      const listener = () => handler();
      ipcRenderer.on(CHANNELS.PaletteToggle, listener);
      return () => {
        ipcRenderer.off(CHANNELS.PaletteToggle, listener);
      };
    },
    onAddProject: (handler: () => void): (() => void) => {
      const listener = () => handler();
      ipcRenderer.on(CHANNELS.PaletteAddProject, listener);
      return () => {
        ipcRenderer.off(CHANNELS.PaletteAddProject, listener);
      };
    },
  },
  scripts: {
    run: (input: {
      projectId: string;
      worktreeId: string;
      script: ScriptName;
    }): Promise<{ runId: string }> =>
      ipcRenderer.invoke(CHANNELS.ScriptsRun, input),
    cancel: (runId: string): Promise<{ cancelled: boolean }> =>
      ipcRenderer.invoke(CHANNELS.ScriptsCancel, { runId }),
    onEvent: (handler: (event: ScriptEvent) => void): (() => void) => {
      const listener = (_event: unknown, payload: ScriptEvent) =>
        handler(payload);
      ipcRenderer.on(CHANNELS.ScriptsEvent, listener);
      return () => {
        ipcRenderer.off(CHANNELS.ScriptsEvent, listener);
      };
    },
  },
  launchers: {
    detected: (): Promise<DetectedLauncher[]> =>
      ipcRenderer.invoke(CHANNELS.LaunchersDetect),
    forProject: (projectId: string): Promise<{ entries: LauncherEntry[] }> =>
      ipcRenderer.invoke(CHANNELS.LaunchersForProject, { projectId }),
    launch: (input: {
      projectId: string;
      worktreeId: string;
      launcherId: string;
    }): Promise<void> => ipcRenderer.invoke(CHANNELS.LaunchersLaunch, input),
  },
} as const;

export type RendererApi = typeof api;

contextBridge.exposeInMainWorld("api", api);
