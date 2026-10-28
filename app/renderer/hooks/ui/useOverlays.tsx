import { createContext, use, useState, type ReactNode } from "react";

interface OverlaysState {
  // The ⌘K worktree palette.
  paletteOpen: boolean;
  setPaletteOpen: (open: boolean) => void;
  addProjectOpen: boolean;
  setAddProjectOpen: (open: boolean) => void;
  openAddProject: () => void;
}

const OverlaysContext = createContext<OverlaysState | null>(null);

export function OverlaysProvider({ children }: { children: ReactNode }) {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [addProjectOpen, setAddProjectOpen] = useState(false);

  const value: OverlaysState = {
    paletteOpen,
    setPaletteOpen,
    addProjectOpen,
    setAddProjectOpen,
    // Closing the palette first keeps Add project sane while it is open. The
    // modal shouldn't stack on top of it.
    openAddProject: () => {
      setPaletteOpen(false);
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
