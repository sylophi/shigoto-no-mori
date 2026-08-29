// Header for remote worktrees whose project exists on no local
// checkout: ProjectRow's typography without its affordances (no
// collapse -- nothing persists it for a foreign project -- and no local
// actions). The group may span several devices sharing one repo
// identity; the per-row device markers below it tell those apart.
//
// The icon is the repo's own, fetched from the first member device with
// a live api (projects:icon sits on the ungated read surface, so a
// read-only peer serves it). With no member connected the header falls
// back to the generic glyph rather than mounting a scope that cannot
// fetch.
import { FolderGit2 } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { HostScopeProvider } from "@/hooks/remote/useHostScope";
import { useRemoteDevices } from "@/hooks/remote/useRemoteDevices";
import { useIsTruncated } from "@/hooks/ui/useIsTruncated";
import { cn } from "@/lib/utils";
import { PROJECT_HEADER_BASE } from "./ProjectHeader";
import { ProjectIcon } from "./ProjectIcon";

interface RemoteProjectRowProps {
  name: string;
  count: number;
  iconSources: readonly { deviceId: string; projectId: string }[];
}

export function RemoteProjectRow({
  name,
  count,
  iconSources,
}: RemoteProjectRowProps) {
  const devices = useRemoteDevices();
  const live = iconSources
    .map((source) => ({
      ...source,
      api: devices.find((device) => device.deviceId === source.deviceId)?.api,
    }))
    .find((source) => source.api !== undefined);
  // Same truncation-aware tooltip as ProjectHeader, so a long remote
  // name is recoverable on hover exactly like a local one.
  const [nameRef, isTruncated] = useIsTruncated<HTMLSpanElement>();

  return (
    <Tooltip disabled={!isTruncated}>
      <TooltipTrigger
        render={
          <div className={cn(PROJECT_HEADER_BASE, "text-muted-foreground")}>
            {live?.api === undefined ? (
              <FolderGit2 className="size-3.5 shrink-0 text-muted-foreground/50" />
            ) : (
              <HostScopeProvider deviceId={live.deviceId} api={live.api}>
                <ProjectIcon projectId={live.projectId} fallback={FolderGit2} />
              </HostScopeProvider>
            )}
            <span ref={nameRef} className="min-w-0 truncate">
              {name}
            </span>
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
