// Header for remote worktrees whose project exists on no local
// checkout: ProjectRow's typography without its affordances (no
// collapse -- nothing persists it for a foreign project -- and no local
// actions). The group may span several devices sharing one repo
// identity, and the per-row device markers below it tell those apart.
//
// The icon is the repo's own, read from the first member device with a
// live api (projects:icon sits on the ungated read surface, so a
// read-only peer serves it). When every member is asleep the row keeps
// reading the member that last served it, because that is the key the
// cached icon lives under. A group that never had a live member reads
// its first, and with nothing cached falls back to the generic glyph.
import { useRef } from "react";
import { FolderGit2 } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useRemoteDevices } from "@/hooks/remote/useRemoteDevices";
import { useIsTruncated } from "@/hooks/ui/useIsTruncated";
import { cn } from "@/lib/utils";
import { DeviceBadgeCluster, type SidebarDeviceBadge } from "./DeviceBadge";
import { PROJECT_HEADER_BASE } from "./ProjectHeader";
import { ProjectIcon } from "./ProjectIcon";

interface RemoteProjectRowProps {
  name: string;
  count: number;
  devices: readonly SidebarDeviceBadge[];
  iconSources: readonly { deviceId: string; projectId: string }[];
}

export function RemoteProjectRow({
  name,
  count,
  devices,
  iconSources,
}: RemoteProjectRowProps) {
  const registry = useRemoteDevices();
  const live = iconSources.find(
    (source) =>
      registry.find((device) => device.deviceId === source.deviceId)?.api !==
      undefined,
  );
  const lastLive = useRef(live);
  if (live !== undefined) lastLive.current = live;
  const iconSource = live ?? lastLive.current ?? iconSources[0];
  // Same truncation-aware tooltip as ProjectHeader, so a long remote
  // name is recoverable on hover exactly like a local one.
  const [nameRef, isTruncated] = useIsTruncated<HTMLSpanElement>();

  return (
    <Tooltip disabled={!isTruncated}>
      <TooltipTrigger
        render={
          <div className={cn(PROJECT_HEADER_BASE, "text-muted-foreground")}>
            {iconSource === undefined ? (
              <FolderGit2 className="size-3.5 shrink-0 text-muted-foreground/50" />
            ) : (
              <ProjectIcon
                projectId={iconSource.projectId}
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
  );
}
