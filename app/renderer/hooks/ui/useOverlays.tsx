import { createContext, use, useState, type ReactNode } from "react";

interface OverlaysState {
  // The ⌘K worktree palette.
  paletteOpen: boolean;
  setPaletteOpen: (open: boolean) => void;
  addProjectOpen: boolean;
  setAddProjectOpen: (open: boolean) => void;
  // What the dialog opens on, for a caller that already knows.
  addProjectTarget: AddProjectTarget;
  // Moves with every open that names a target. The dialog keys on it,
  // so a target arriving while it is already open (the caller awaited
  // something first) reseeds it instead of being dropped.
  addProjectRequest: number;
  openAddProject: (target?: AddProjectTarget) => void;
}

export interface AddProjectTarget {
  // Undefined opens on this device (or, on a hostless client, the
  // first device that answers).
  deviceId?: string;
  // What the input starts as: a path to browse, or a URL to clone.
  query?: string;
}

const NO_TARGET: AddProjectTarget = {};

const OverlaysContext = createContext<OverlaysState | null>(null);

export function OverlaysProvider({ children }: { children: ReactNode }) {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [addProjectOpen, setAddProjectOpen] = useState(false);
  const [addProjectTarget, setAddProjectTarget] = useState(NO_TARGET);
  const [addProjectRequest, setAddProjectRequest] = useState(0);

  const value: OverlaysState = {
    paletteOpen,
    setPaletteOpen,
    addProjectOpen,
    setAddProjectOpen,
    addProjectTarget,
    addProjectRequest,
    // Closing the palette first keeps ⌘N sane while it is open. The
    // modal shouldn't stack on top of it.
    openAddProject: (target = NO_TARGET) => {
      setPaletteOpen(false);
      setAddProjectTarget(target);
      if (target !== NO_TARGET) setAddProjectRequest((n) => n + 1);
      setAddProjectOpen(true);
    },
  };

  return <OverlaysContext value={value}>{children}</OverlaysContext>;
}

export function useOverlays(): OverlaysState {
  const ctx = use(OverlaysContext);
  if (!ctx) {
    throw new Error("useOverlays must be used inside OverlaysProvider");
  }
  return ctx;
}
