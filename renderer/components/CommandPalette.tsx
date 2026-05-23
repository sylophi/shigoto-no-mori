import { useEffect } from "react";
import { ModalShell } from "@/components/ui/modal-shell";
import { useCommandPalette } from "@/hooks/useCommandPalette";
import { AddProjectView } from "./palette/AddProjectView";
import { BrowseView } from "./palette/BrowseView";

export function CommandPalette() {
  const { open, mode, setOpen, toggle, openIn } = useCommandPalette();

  // Both shortcuts are wired via native menu accelerators in main/menu.ts
  // — View → Command palette (⌘⇧P, also ⌘P) and File → Add project… (⌘N).
  useEffect(() => window.api.palette.onToggle(toggle), [toggle]);
  useEffect(
    () => window.api.palette.onAddProject(() => openIn("add-project")),
    [openIn],
  );

  if (!open) return null;

  // AddProjectView owns its own Escape handling (cancels scan stage, or
  // closes from the browse stage); only escape-to-close from browse mode.
  return (
    <ModalShell
      onClose={() => setOpen(false)}
      closeOnEscape={mode === "browse"}
    >
      {mode === "browse" ? (
        <BrowseView onAddProject={() => openIn("add-project")} />
      ) : (
        <AddProjectView onClose={() => setOpen(false)} />
      )}
    </ModalShell>
  );
}
