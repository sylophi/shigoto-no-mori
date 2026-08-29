// Header for remote worktrees whose project exists on no local
// checkout: ProjectRow's typography without its affordances (no
// collapse -- nothing persists it for a foreign project -- and no local
// actions). The group may span several devices sharing one repo
// identity; the per-row device markers below it tell those apart.
//
// The icon is the repo's own, fetched from the named device over its
// api (projects:icon sits on the ungated read surface, so a read-only
// peer serves it). Without a live api the header falls back to the
// generic glyph rather than mounting a scope that cannot fetch.
import { FolderGit2 } from "lucide-react";
import { HostScopeProvider } from "@/hooks/remote/useHostScope";
import { useRemoteDevices } from "@/hooks/remote/useRemoteDevices";
import { ProjectIcon } from "./ProjectIcon";

interface RemoteProjectRowProps {
  name: string;
  count: number;
  iconDeviceId: string;
  iconProjectId: string;
}

export function RemoteProjectRow({
  name,
  count,
  iconDeviceId,
  iconProjectId,
}: RemoteProjectRowProps) {
  const api = useRemoteDevices().find(
    (device) => device.deviceId === iconDeviceId,
  )?.api;
  return (
    <div className="flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground">
      {api === undefined ? (
        <FolderGit2 className="size-3.5 shrink-0 text-muted-foreground/50" />
      ) : (
        <HostScopeProvider deviceId={iconDeviceId} api={api}>
          <ProjectIcon projectId={iconProjectId} fallback={FolderGit2} />
        </HostScopeProvider>
      )}
      <span className="min-w-0 truncate">{name}</span>
      <span className="shrink-0 text-[10px] text-muted-foreground/70">
        {count}
      </span>
    </div>
  );
}
