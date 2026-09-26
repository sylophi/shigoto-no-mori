import { TerrierPaw } from "@/components/shared/TerrierPaw";
import {
  useMarkTerrierProjects,
  useTerrierMarksHere,
} from "@/hooks/config/useSidebarMarks";

// The paw after a project's name in the sidebar, while this window has
// Mark terrier projects on (Settings, Appearance). Whether the row
// counts as terrier's is the caller's call: an inbox row asks its own
// checkout, the tree's header every device's checkout in its group.
export function TerrierMark({ terrier }: { terrier: boolean }) {
  const mark = useMarkTerrierProjects();
  if (!mark || !terrier) return null;
  return <ShownTerrierMark />;
}

// Split out so only a row that would wear the paw reads the device
// config behind useTerrierMarksHere.
function ShownTerrierMark() {
  return useTerrierMarksHere() ? <TerrierPaw className="size-3" /> : null;
}
