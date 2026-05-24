import { createContext, use, useState, type ReactNode } from "react";

export type PaletteMode = "browse" | "add-project";

interface CommandPaletteState {
  open: boolean;
  mode: PaletteMode;
  openIn: (mode: PaletteMode) => void;
  setOpen: (open: boolean) => void;
  toggle: () => void;
}

const CommandPaletteContext = createContext<CommandPaletteState | null>(null);

export function CommandPaletteProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<PaletteMode>("browse");

  const value: CommandPaletteState = {
    open,
    mode,
    openIn: (next: PaletteMode) => {
      setMode(next);
      setOpen(true);
    },
    setOpen,
    toggle: () => {
      setOpen((v) => {
        if (!v) setMode("browse");
        return !v;
      });
    },
  };

  return (
    <CommandPaletteContext value={value}>{children}</CommandPaletteContext>
  );
}

export function useCommandPalette(): CommandPaletteState {
  const ctx = use(CommandPaletteContext);
  if (!ctx) {
    throw new Error(
      "useCommandPalette must be used inside CommandPaletteProvider",
    );
  }
  return ctx;
}
