// Header for remote worktrees whose project exists on no local
// checkout: ProjectRow's typography and its actions
// (ProjectGroupActions), scoped to the devices the project lives on.
// The group may span several devices sharing one repo identity, and
// the per-row device markers below it tell those apart. No collapse:
// nothing persists a fold for a foreign project.
//
// The icon is the repo's own, read from the first live member
// (projects:icon sits on the ungated read surface, so a read-only peer
// serves it). When every member is asleep the row keeps reading the
// member that last served it, because that is the key the cached icon
// lives under. A group that never had a live member reads its first,
// and with nothing cached falls back to the generic glyph.
import { useRef } from "react";
import { FolderGit2 } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useIsTruncated } from "@/hooks/ui/useIsTruncated";
import { cn } from "@/lib/utils";
import { DeviceBadgeCluster, type SidebarDeviceBadge } from "./DeviceBadge";
import { ProjectGroupActions, useGroupMembers } from "./ProjectGroupActions";
import { PROJECT_HEADER_BASE } from "./ProjectHeader";
import { ProjectIcon } from "./ProjectIcon";
import type { RemoteProjectMember } from "./sidebarRow";

interface RemoteProjectRowProps {
  name: string;
  count: number;
  devices: readonly SidebarDeviceBadge[];
  members: readonly RemoteProjectMember[];
  // True while the cursor is anywhere in this group's region (header or
  // one of its worktree rows), the same rule ProjectRow follows.
  isHovered: boolean;
}

export function RemoteProjectRow({
  name,
  count,
  devices,
  members,
  isHovered,
}: RemoteProjectRowProps) {
  const group = useGroupMembers(members, undefined);
  const live = group.find((member) => member.api !== undefined);
  const lastLive = useRef(live);
  if (live !== undefined) lastLive.current = live;
  const iconSource = live ?? lastLive.current ?? members[0];
  // Same truncation-aware tooltip as ProjectHeader, so a long remote
  // name is recoverable on hover exactly like a local one.
  const [nameRef, isTruncated] = useIsTruncated<HTMLSpanElement>();
  // Right-clicking the header pops the `…` menu, as on a local header.
  const triggerRef = useRef<HTMLButtonElement>(null);
  const onHeaderContextMenu = (event: React.MouseEvent) => {
    if (live === undefined) return;
    event.preventDefault();
    triggerRef.current?.click();
  };

  return (
    <div className="flex items-center gap-0.5 py-0.5">
      <Tooltip disabled={!isTruncated}>
        <TooltipTrigger
          render={
            <div
              onContextMenu={onHeaderContextMenu}
              className={cn(PROJECT_HEADER_BASE, "text-muted-foreground")}
            >
              {iconSource === undefined ? (
                <FolderGit2 className="size-3.5 shrink-0 text-muted-foreground/50" />
              ) : (
                <ProjectIcon
                  projectId={iconSource.project.id}
                  deviceId={iconSource.deviceId}
                  fallback={FolderGit2}
                />
              )}
              <span ref={nameRef} className="min-w-0 truncate">
                {name}
              </span>
              <DeviceBadgeCluster devices={devices} />
              <span className="shrink-0 text-[10px] text-muted-foreground/70">
                {count}
              </span>
            </div>
          }
        />
        <TooltipContent>{name}</TooltipContent>
      </Tooltip>
      <ProjectGroupActions
        name={name}
        identity={members[0]?.project.identity}
        members={group}
        isHovered={isHovered}
        triggerRef={triggerRef}
      />
    </div>
  );
}
