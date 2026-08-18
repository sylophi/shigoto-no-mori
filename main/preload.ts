// Preload script — runs in an isolated context with access to Node + Electron APIs.
// Exposes a typed `window.api` to the renderer.
// https://www.electronjs.org/docs/latest/tutorial/process-model#preload-scripts
import { contextBridge } from "electron";
import {
  branches,
  commandPalette,
  dialog,
  fs,
  git,
  githubCli,
  globalConfig,
  launchers,
  menu,
  nav,
  packageScripts,
  portPool,
  projectLauncher,
  projects,
  runtime,
  scripts,
  cli,
  shell,
  shigomori,
  updater,
  windowApi,
  worktreeData,
  worktrees,
} from "@shared/ipc/client";

const api = {
  projects,
  worktrees,
  branches,
  dialog,
  runtime,
  fs,
  shigomori,
  worktreeData,
  globalConfig,
  shell,
  projectLauncher,
  commandPalette,
  nav,
  menu,
  window: windowApi,
  git,
  packageScripts,
  portPool,
  githubCli,
  scripts,
  cli,
  updater,
  launchers,
} as const;

export type RendererApi = typeof api;

contextBridge.exposeInMainWorld("api", api);
