// Preload script — runs in an isolated context with access to Node + Electron APIs.
// Exposes a typed `window.api` to the renderer.
// https://www.electronjs.org/docs/latest/tutorial/process-model#preload-scripts
import { contextBridge } from "electron";
import { branches } from "@shared/ipc/modules/branches";
import { dialog } from "@shared/ipc/modules/dialog";
import { fs } from "@shared/ipc/modules/fs";
import { git } from "@shared/ipc/modules/git";
import { githubCli } from "@shared/ipc/modules/githubCli";
import { globalConfig } from "@shared/ipc/modules/globalConfig";
import { launchers } from "@shared/ipc/modules/launchers";
import { menu } from "@shared/ipc/modules/menu";
import { nav } from "@shared/ipc/modules/nav";
import { packageScripts } from "@shared/ipc/modules/packageScripts";
import { palette } from "@shared/ipc/modules/palette";
import { portPool } from "@shared/ipc/modules/portPool";
import { projects } from "@shared/ipc/modules/projects";
import { runtime } from "@shared/ipc/modules/runtime";
import { scripts } from "@shared/ipc/modules/scripts";
import { shell } from "@shared/ipc/modules/shell";
import { shigomori, worktreeData } from "@shared/ipc/modules/shigomori";
import { updater } from "@shared/ipc/modules/updater";
import { windowApi } from "@shared/ipc/modules/window";
import { worktrees } from "@shared/ipc/modules/worktrees";

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
  palette,
  nav,
  menu,
  window: windowApi,
  git,
  packageScripts,
  portPool,
  githubCli,
  scripts,
  updater,
  launchers,
} as const;

export type RendererApi = typeof api;

contextBridge.exposeInMainWorld("api", api);
