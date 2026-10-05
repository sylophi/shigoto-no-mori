// The Live page's surfaces: a device's heading, the card of one
// worktree's live things (built like a project tile, the worktree named
// the way the sidebar names it, its branch over its folder), and the
// line each live thing takes inside it.
import type React from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Cable } from "lucide-react";
import { DeviceMark } from "@/components/shared/DeviceGlyph";
import { ProjectIcon } from "@/components/shared/ProjectIcon";
import { BranchLabel } from "@/components/ui/branch-label";
import { TONE_TEXT } from "@/components/ui/status-dot";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { projectsQueryOptions } from "@/hooks/projects/useProjects";
import { useDeviceApi } from "@/hooks/remote/useDeviceApi";
import {
  useDeviceIcon,
  useDeviceProperName,
  useRemoteDevice,
} from "@/hooks/remote/useRemoteDevices";
import { worktreesQueryOptions } from "@/hooks/worktrees/useWorktrees";
import { deviceStatusView, THIS_DEVICE_VIEW } from "@/lib/remote/deviceStatus";
import { WORKTREE_ROUTE_PATHS } from "@/lib/routePaths";
import { cn } from "@/lib/utils";
import type { LiveCard as LiveCardModel } from "./liveModel";

// A device's heading over its cards: its mark in its connection tone,
// its name, where it stands, and how much runs there.
export function DeviceHeading({
  deviceId,
  summary,
}: {
  deviceId: string;
  summary: string;
}) {
  const icon = useDeviceIcon(deviceId);
  const name = useDeviceProperName(deviceId);
  const device = useRemoteDevice(deviceId);
  const status = device ? deviceStatusView(device.status) : THIS_DEVICE_VIEW;
  return (
    <div className="flex items-center gap-2">
      <DeviceMark icon={icon} tone={status.tone} />
      <h2 className="truncate text-sm font-medium">{name}</h2>
      <span className={cn("shrink-0 text-xs", TONE_TEXT[status.tone])}>
        {status.label}
      </span>
      <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">
        {summary}
      </span>
    </div>
  );
}

export function LiveCard({
  card,
  children,
}: {
  card: LiveCardModel;
  children: React.ReactNode;
}) {
  return (
    <article className="flex flex-col gap-3 rounded-lg border border-border bg-card p-3">
      {card.worktree ? (
        <WorktreeHeader deviceId={card.deviceId} {...card.worktree} />
      ) : (
        <PortsHeader />
      )}
      <ul className="flex flex-col gap-1">{children}</ul>
    </article>
  );
}

// The worktree a card is for: its project's icon, its branch (the
// link to its page) and its folder and project under it. Read off the
// same cached lists the sidebar keeps. One the device no longer lists
// (removed while something still ran there) says so.
function WorktreeHeader({
  deviceId,
  projectId,
  worktreeId,
}: {
  deviceId: string;
  projectId: string;
  worktreeId: string;
}) {
  const scope = useDeviceApi(deviceId);
  const project = useQuery({
    ...projectsQueryOptions(scope),
    select: (projects) => projects.find((entry) => entry.id === projectId),
    meta: { silentError: true },
  }).data;
  const worktree = useQuery({
    ...worktreesQueryOptions(projectId, scope),
    select: (worktrees) => worktrees.find((entry) => entry.id === worktreeId),
  }).data;
  return (
    <header className="flex min-w-0 items-center gap-2.5">
      <ProjectIcon
        projectId={projectId}
        name={project?.name ?? "?"}
        deviceId={deviceId}
        className="size-8"
      />
      <div className="flex min-w-0 flex-col gap-0.5">
        {worktree ? (
          <SimpleTooltip whenTruncated tip={worktree.branch}>
            <Link
              to={WORKTREE_ROUTE_PATHS.detail}
              params={{ deviceId, projectId, worktreeId }}
              className="truncate font-mono text-sm font-medium hover:underline"
            >
              <BranchLabel
                branch={worktree.branch}
                detached={worktree.detached}
                suffixClassName="text-xs"
              />
            </Link>
          </SimpleTooltip>
        ) : (
          <span className="truncate text-sm text-muted-foreground italic">
            Removed worktree
          </span>
        )}
        <span className="truncate text-2xs text-muted-foreground">
          {[worktree?.name, project?.name].filter(Boolean).join(" · ")}
        </span>
      </div>
    </header>
  );
}

// A device's loose forwards, the ones switched on from the account
// page rather than a worktree.
function PortsHeader() {
  return (
    <header className="flex min-w-0 items-center gap-2.5">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
        <Cable aria-hidden className="size-4" />
      </span>
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="truncate text-sm font-medium">Forwarded ports</span>
        <span className="truncate text-2xs text-muted-foreground">
          Not tied to a worktree
        </span>
      </div>
    </header>
  );
}

// One live thing inside a card: its mark, what it is, the fact beside
// it, and its quiet actions at the end.
export function LiveLine({
  mark,
  label,
  meta,
  actions,
}: {
  mark: React.ReactNode;
  label: React.ReactNode;
  meta?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <li className="flex min-h-8 items-center gap-2 rounded-md bg-muted/60 py-1 pr-1 pl-2 text-xs">
      <span className="flex size-4 shrink-0 items-center justify-center">
        {mark}
      </span>
      <span className="flex min-w-0 items-center gap-1">{label}</span>
      {meta && (
        <span className="flex min-w-0 shrink items-center gap-1 truncate text-muted-foreground">
          {meta}
        </span>
      )}
      {actions && (
        <span className="ml-auto flex shrink-0 items-center gap-0.5">
          {actions}
        </span>
      )}
    </li>
  );
}
