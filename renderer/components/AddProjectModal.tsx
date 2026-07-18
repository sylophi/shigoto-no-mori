import { useEffect } from "react";
import { ModalShell } from "@/components/ui/modal-shell";
import { useOverlays } from "@/hooks/ui/useOverlays";
import { AddProjectView } from "./addProject/AddProjectView";

// Standalone host for the add-project flow (File → Add project…, ⌘N, and
// the sidebar ＋ button). The shortcut is a native menu accelerator in
// main/menu.ts that broadcasts over IPC.
export function AddProjectModal() {
  const { addProjectOpen, setAddProjectOpen, openAddProject } = useOverlays();

  useEffect(
    () => window.api.projectLauncher.onAddProject(openAddProject),
    [openAddProject],
  );

  if (!addProjectOpen) return null;

  // AddProjectView owns its own Escape handling (cancels the scan stage,
  // or closes from the browse stage), so the shell must not also close.
  return (
    <ModalShell onClose={() => setAddProjectOpen(false)} closeOnEscape={false}>
      <AddProjectView onClose={() => setAddProjectOpen(false)} />
    </ModalShell>
  );
}
