import type { Project } from "@shared/schemas";
import { getBrowseParentPath, tildify } from "@/lib/projectPaths";

// Where a clone should land when nobody has said: the folder this
// device already keeps most of its repos in, so a new one joins its
// siblings instead of being dropped in the home folder. Counted off
// the device's own registered projects, which is the only evidence of
// its layout a peer can see. Ties go to the earliest, the sidebar's
// order. A device with no projects yet gets its home folder.
export function defaultCloneParent(
  projects: readonly Project[],
  home: string | null,
): string {
  const counts = new Map<string, number>();
  for (const project of projects) {
    const parent = getBrowseParentPath(project.path);
    if (parent !== null) counts.set(parent, (counts.get(parent) ?? 0) + 1);
  }
  let best: string | null = null;
  for (const [parent, count] of counts) {
    if (best === null || count > (counts.get(best) ?? 0)) best = parent;
  }
  return best === null ? "~/" : tildify(best, home);
}
