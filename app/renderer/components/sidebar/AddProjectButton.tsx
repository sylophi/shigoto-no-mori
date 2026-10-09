// The add-project button (AddProjectButtonView), opening the dialog.
import { useOverlays } from "@/hooks/ui/useOverlays";
import { hasLocalHost } from "@/lib/localHost";
import { AddProjectButtonView } from "./AddProjectButtonView";

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
