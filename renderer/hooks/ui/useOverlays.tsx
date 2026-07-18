import { createContext, use, useState, type ReactNode } from "react";

interface OverlaysState {
  launcherOpen: boolean;
  setLauncherOpen: (open: boolean) => void;
  toggleLauncher: () => void;
  addProjectOpen: boolean;
  setAddProjectOpen: (open: boolean) => void;
  openAddProject: () => void;
}

const OverlaysContext = createContext<OverlaysState | null>(null);

export function OverlaysProvider({ children }: { children: ReactNode }) {
  const [launcherOpen, setLauncherOpen] = useState(false);
  const [addProjectOpen, setAddProjectOpen] = useState(false);

  const value: OverlaysState = {
    launcherOpen,
    setLauncherOpen,
    toggleLauncher: () => setLauncherOpen((v) => !v),
    addProjectOpen,
    setAddProjectOpen,
    // Closing the launcher first keeps ⌘N sane while it's open — the modal
    // shouldn't stack on top of the full-screen overlay.
    openAddProject: () => {
      setLauncherOpen(false);
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
