import { TerrierPaw } from "@/components/shared/TerrierPaw";
import {
  useMarkTerrierProjects,
  useTerrierMarksHere,
} from "@/hooks/config/useSidebarMarks";

// The paw after the open project's name in the sidebar, while this
// window has Mark terrier projects on (Settings, Appearance). Whether
// the project counts as terrier's is the caller's call: the header asks
// every device's checkout in its group.
export function TerrierMark({ terrier }: { terrier: boolean }) {
  const mark = useMarkTerrierProjects();
  const here = useTerrierMarksHere();
  return mark && here && terrier ? <TerrierPaw className="size-3" /> : null;
}
