import { trayContract } from "@shared/ipc/modules/tray";
import type { Handlers } from "@shared/ipc/types";

// The electron layer injects the real implementation at boot, same as
// the menu module: this file stays free of Electron imports (and of the
// Tray/BrowserWindow lifetime it would otherwise have to reach into).
export interface TrayImpl {
  resize: (height: number) => void;
  close: () => void;
  revealWorktree: (projectId: string, worktreeId: string) => void;
  revealNewWorktree: (projectId: string) => void;
  toggleMainWindow: () => boolean;
  mainWindowVisible: () => boolean;
}

const notInstalled = (): never => {
  throw new Error("tray handler invoked before electron registered impl");
};

let impl: TrayImpl = {
  resize: notInstalled,
  close: notInstalled,
  revealWorktree: notInstalled,
  revealNewWorktree: notInstalled,
  toggleMainWindow: notInstalled,
  mainWindowVisible: notInstalled,
};

export function setTrayImpl(next: TrayImpl): void {
  impl = next;
}

export const trayHandlers: Handlers<typeof trayContract> = {
  resize: ({ height }) => {
    impl.resize(height);
  },
  close: () => {
    impl.close();
  },
  revealWorktree: ({ projectId, worktreeId }) => {
    impl.revealWorktree(projectId, worktreeId);
  },
  revealNewWorktree: ({ projectId }) => {
    impl.revealNewWorktree(projectId);
  },
  toggleMainWindow: () => impl.toggleMainWindow(),
  mainWindowVisible: () => impl.mainWindowVisible(),
};
