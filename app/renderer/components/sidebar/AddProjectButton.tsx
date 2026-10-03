import { useOverlays } from "@/hooks/ui/useOverlays";
import { hasLocalHost } from "@/lib/localHost";
import { AddProjectButtonView } from "./AddProjectButtonView";

// Opens the add-project dialog (AddProjectButtonView draws the button).
export function AddProjectButton({ outline = false }: { outline?: boolean }) {
  const { openAddProject } = useOverlays();
  return (
    <AddProjectButtonView
      outline={outline}
      hasLocalHost={hasLocalHost}
      onClick={() => openAddProject()}
    />
  );
}
