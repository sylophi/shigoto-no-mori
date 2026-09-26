import { TerrierPaw } from "@/components/shared/TerrierPaw";
import { useMarkTerrierProjects } from "@/hooks/config/useMarkTerrierProjects";

// The paw after a project's name in the sidebar, while this window has
// Mark terrier projects on (Settings, Appearance). Whether the row
// counts as terrier's is the caller's call: an inbox row asks its own
// checkout, the tree's header every device's checkout in its group.
export function TerrierMark({ terrier }: { terrier: boolean }) {
  const mark = useMarkTerrierProjects();
  if (!mark || !terrier) return null;
  return <TerrierPaw className="size-3" />;
}
