// Where a repo is cloned on a device that has no checkout of it, when
// nobody said: the add-project dialog's clone, and every move that
// clones the repo on its destination first (the flows' review,
// renderer/components/worktreeDetail/flow/cloneDestination.tsx, and the
// CLI's send, host/ipc/modules/control.ts). Tildified, since the
// device that clones expands `~` itself.
import type { Project } from "@shared/schemas";
import {
  getBrowseLeafSegment,
  getBrowseParentPath,
  normalizeForSubmit,
  tildify,
} from "@shared/projectPaths";

// The folder this device already keeps most of its repos in, so a new
// one joins its siblings instead of being dropped in the home folder.
// Counted off the device's own registered projects, which is the only
// evidence of its layout a peer can see. Ties go to the earliest, the
// sidebar's order. A device with no projects yet gets its home folder.
export function defaultCloneParent(
  projects: readonly Pick<Project, "path">[],
  home: string | null,
): string {
  const counts = new Map<string, number>();
  for (const project of projects) {
    const parent = getBrowseParentPath(project.path);
    if (parent !== null) counts.set(parent, (counts.get(parent) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [parent, count] of counts) {
    if (count > bestCount) {
      best = parent;
      bestCount = count;
    }
  }
  return best === null ? "~/" : tildify(best, home);
}

// A move's default: the source's own layout, its checkout's parent
// with the source's home swapped for the destination's, so the two
// machines end up alike without a pick. A checkout outside the
// source's home falls back to where the destination keeps its repos.
// With a trailing separator, the way a folder pick reads.
export function moveCloneParent(input: {
  sourcePath: string;
  sourceHome: string | null | undefined;
  destinationHome: string | null;
  destinationProjects: readonly Pick<Project, "path">[];
}): string {
  const sourceParent = getBrowseParentPath(input.sourcePath);
  const alike =
    sourceParent === null ? null : tildify(sourceParent, input.sourceHome);
  return alike?.startsWith("~")
    ? alike
    : defaultCloneParent(input.destinationProjects, input.destinationHome);
}

// The pair a move takes as its `cloneInto`: the parent as submitted,
// and the source checkout's own folder name.
export function cloneIntoOf(
  parent: string,
  sourcePath: string,
): { parentDir: string; name: string } {
  return {
    parentDir: normalizeForSubmit(parent),
    name: getBrowseLeafSegment(sourcePath),
  };
}
