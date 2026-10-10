// The add-project button (AddProjectButtonView), opening the dialog.
import { useOverlays } from "@/hooks/ui/useOverlays";
import { hasLocalHost } from "@/lib/localHost";
import { AddProjectButtonView } from "@shigomori/ui/views/sidebar/AddProjectButtonView.tsx";

export function AddProjectButton({ outline }: { outline?: boolean }) {
  const { openAddProject } = useOverlays();
  return (
    <AddProjectButtonView
      outline={outline}
      hasLocalHost={hasLocalHost}
      onClick={() => openAddProject()}
    />
  );
}
