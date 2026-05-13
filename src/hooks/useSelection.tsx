import { createContext, use, useState, type ReactNode } from "react";

type SelectionMode =
  | "worktree"
  | "new-worktree"
  | "configure"
  | "settings"
  | "empty";

interface SelectionState {
  mode: SelectionMode;
  selectedWorktreeId: string | null;
  selectedProjectId: string | null;
  selectWorktree: (worktreeId: string) => void;
  beginNewWorktree: (projectId: string) => void;
  beginConfigureProject: (projectId: string) => void;
  openSettings: () => void;
  clear: () => void;
}

const SelectionContext = createContext<SelectionState | null>(null);

export function SelectionProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<SelectionMode>("empty");
  const [selectedWorktreeId, setSelectedWorktreeId] = useState<string | null>(
    null,
  );
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    null,
  );

  const value: SelectionState = {
    mode,
    selectedWorktreeId,
    selectedProjectId,
    selectWorktree: (worktreeId: string) => {
      setSelectedWorktreeId(worktreeId);
      setMode("worktree");
    },
    beginNewWorktree: (projectId: string) => {
      setSelectedProjectId(projectId);
      setMode("new-worktree");
    },
    beginConfigureProject: (projectId: string) => {
      setSelectedProjectId(projectId);
      setMode("configure");
    },
    openSettings: () => {
      setSelectedWorktreeId(null);
      setSelectedProjectId(null);
      setMode("settings");
    },
    clear: () => {
      setSelectedWorktreeId(null);
      setSelectedProjectId(null);
      setMode("empty");
    },
  };

  return <SelectionContext value={value}>{children}</SelectionContext>;
}

export function useSelection(): SelectionState {
  const ctx = use(SelectionContext);
  if (!ctx) {
    throw new Error("useSelection must be used inside SelectionProvider");
  }
  return ctx;
}
