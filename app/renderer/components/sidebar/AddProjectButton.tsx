// The add-project button (AddProjectButtonView), opening the dialog.
import { useOverlays } from "@/hooks/ui/useOverlays";
import { useKeymap } from "@/hooks/ui/useKeymap";
import { AddProjectButtonView } from "@shigomori/ui/views/sidebar/AddProjectButtonView.tsx";

export function AddProjectButton({ outline }: { outline?: boolean }) {
  const { openAddProject } = useOverlays();
  const keys = useKeymap().get("addProject");
  return (
    <AddProjectButtonView
      outline={outline}
      keys={keys?.aria}
      onClick={() => openAddProject()}
    />
  );
}
