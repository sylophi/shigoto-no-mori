import { useEffect } from "react";
import { ModalShell } from "@/components/ui/modal-shell";
import { useCommandPalette } from "@/hooks/ui/useCommandPalette";
import { isMac } from "@/lib/platform";
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

  // The bare ⌘P synonym lives on a hidden menu item, and Electron only
  // keeps accelerators live for hidden items on macOS. Elsewhere the
  // keystroke reaches the renderer instead, so catch Ctrl+P here.
  useEffect(() => {
    if (isMac) return;
    const onKey = (e: KeyboardEvent) => {
      if (
        e.key.toLowerCase() === "p" &&
        e.ctrlKey &&
        !e.shiftKey &&
        !e.altKey &&
        !e.metaKey &&
        !e.repeat
      ) {
        e.preventDefault();
        toggle();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle]);

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
