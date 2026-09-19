import { createContext, use, useState, type ReactNode } from "react";

interface OverlaysState {
  launcherOpen: boolean;
  setLauncherOpen: (open: boolean) => void;
  toggleLauncher: () => void;
  addProjectOpen: boolean;
  setAddProjectOpen: (open: boolean) => void;
  // The device the dialog opens on. Undefined opens on this one (or,
  // on a hostless client, the first device that answers).
  addProjectDeviceId: string | undefined;
  openAddProject: (deviceId?: string) => void;
}

const OverlaysContext = createContext<OverlaysState | null>(null);

export function OverlaysProvider({ children }: { children: ReactNode }) {
  const [launcherOpen, setLauncherOpen] = useState(false);
  const [addProjectOpen, setAddProjectOpen] = useState(false);
  const [addProjectDeviceId, setAddProjectDeviceId] = useState<
    string | undefined
  >();

  const value: OverlaysState = {
    launcherOpen,
    setLauncherOpen,
    toggleLauncher: () => setLauncherOpen((v) => !v),
    addProjectOpen,
    setAddProjectOpen,
    addProjectDeviceId,
    // Closing the launcher first keeps ⌘N sane while it's open. The
    // modal shouldn't stack on top of the full-screen overlay.
    openAddProject: (deviceId) => {
      setLauncherOpen(false);
      setAddProjectDeviceId(deviceId);
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
