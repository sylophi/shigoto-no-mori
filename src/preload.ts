// Preload script — runs in an isolated context with access to Node APIs.
// IPC surface added in subsequent commits as the worktree backend lands.
// https://www.electronjs.org/docs/latest/tutorial/process-model#preload-scripts
import { contextBridge } from "electron";

const api = {} as const;

export type RendererApi = typeof api;

contextBridge.exposeInMainWorld("api", api);
