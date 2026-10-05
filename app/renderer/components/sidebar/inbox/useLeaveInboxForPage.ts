import { useEffect, useRef } from "react";
import { useSetSidebarView } from "@/hooks/projects/useSidebarView";
import { rowDeviceId } from "@/lib/routePaths";
import { usePageOnScreen } from "../openProject";
import type { SidebarViewModel } from "../sidebarRow";

// The inbox leaves some worktrees out (a primary checkout, unless its
// project opts in), so a worktree's page opened from outside the
// sidebar (⌘K, a link) can land on one the inbox has no row for, and
// the sidebar would point at nothing. The tree has a row for every
// worktree, so the sidebar switches to it, as Tab would.
//
// Only for a worktree the inbox has listed and left out on purpose
// (`leftOut`): one not listed yet, or that can't be listed at all, is
// no reason to leave. Only while the device filter shows the page's
// device (`shownDevice`, null for every device), since the tree would
// leave a filtered row out just the same. And once per page, counting
// a page that lands with the tree already showing, so a flip back to
// the inbox while the page stays up is not undone.
export function useLeaveInboxForPage({
  inbox,
  settled,
  shownDevice,
  leftOut,
}: {
  inbox: boolean;
  // The view is the saved one rather than the default standing in.
  settled: boolean;
  shownDevice: string | null;
  leftOut: SidebarViewModel["leftOut"];
}): void {
  const { mutate: setView } = useSetSidebarView();
  const { deviceId, projectId, worktreeId } = usePageOnScreen();
  const checkedRef = useRef<string | null>(null);

  useEffect(() => {
    if (
      deviceId === undefined ||
      projectId === undefined ||
      worktreeId === undefined
    ) {
      checkedRef.current = null;
      return;
    }
    const page = `${deviceId}:${projectId}:${worktreeId}`;
    if (!settled || checkedRef.current === page) return;
    if (!inbox) {
      checkedRef.current = page;
      return;
    }
    if (shownDevice !== null && shownDevice !== deviceId) return;
    if (leftOut?.(worktreeId, rowDeviceId(deviceId))) {
      checkedRef.current = page;
      setView("projects");
    }
  });
}
