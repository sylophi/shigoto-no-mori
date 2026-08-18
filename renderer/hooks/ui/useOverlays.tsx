import { createContext, use, useState, type ReactNode } from "react";

interface OverlaysState {
  launcherOpen: boolean;
  setLauncherOpen: (open: boolean) => void;
  toggleLauncher: () => void;
  paletteOpen: boolean;
  setPaletteOpen: (open: boolean) => void;
  togglePalette: () => void;
  addProjectOpen: boolean;
  setAddProjectOpen: (open: boolean) => void;
  openAddProject: () => void;
}

const OverlaysContext = createContext<OverlaysState | null>(null);

export function OverlaysProvider({ children }: { children: ReactNode }) {
  const [launcherOpen, setLauncherOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [addProjectOpen, setAddProjectOpen] = useState(false);

  const value: OverlaysState = {
    launcherOpen,
    setLauncherOpen,
    // The palette and the launcher are both "jump somewhere" surfaces, so
    // only one is ever up: whichever the user reached for last wins.
    toggleLauncher: () => {
      setPaletteOpen(false);
      setLauncherOpen((v) => !v);
    },
    paletteOpen,
    setPaletteOpen,
    togglePalette: () => {
      setLauncherOpen(false);
      setPaletteOpen((v) => !v);
    },
    addProjectOpen,
    setAddProjectOpen,
    // Closing the other overlays first keeps ⌘N sane while one is open — the
    // modal shouldn't stack on top of a full-screen overlay or the palette.
    openAddProject: () => {
      setLauncherOpen(false);
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
