// The pieces every row of the Live page is built from: one row shape
// (a lead mark, a title line, a detail line, the actions), the device a
// thing runs on, and the worktree it belongs to, named off whichever
// device holds it.
import type React from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { DeviceLead } from "@/components/shared/DeviceGlyph";
import { SimpleTooltip } from "@/components/ui/tooltip";
import type { HostApi } from "@/hooks/remote/useHostScope";
import { projectsQueryOptions } from "@/hooks/projects/useProjects";
import {
  useDeviceIcon,
  useDeviceProperName,
  useRemoteDevice,
} from "@/hooks/remote/useRemoteDevices";
import { worktreesQueryOptions } from "@/hooks/worktrees/useWorktrees";
import { deviceStatusView, deviceTitle } from "@/lib/remote/deviceStatus";
import { WORKTREE_ROUTE_PATHS } from "@/lib/routePaths";

export function LiveList({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <ul
      aria-label={label}
      className="divide-y divide-border overflow-hidden rounded-md border border-border"
    >
      {children}
    </ul>
  );
}

export function LiveRow({
  lead,
  title,
  detail,
  actions,
}: {
  lead: React.ReactNode;
  title: React.ReactNode;
  detail: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <li className="flex items-center gap-3 px-3 py-2.5 text-sm">
      <span className="flex w-4 shrink-0 justify-center">{lead}</span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 items-center gap-1.5">{title}</div>
        <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground">
          {detail}
        </div>
      </div>
      {actions && (
        <div className="flex shrink-0 items-center gap-1">{actions}</div>
      )}
    </li>
  );
}

// A middle dot between two facts on a detail line.
export function Sep() {
  return <span aria-hidden>·</span>;
}

// The device a thing runs on: its connection dot (a peer's), its glyph
// and its name.
export function DeviceRef({ deviceId }: { deviceId: string }) {
  const icon = useDeviceIcon(deviceId);
  const name = useDeviceProperName(deviceId);
  const device = useRemoteDevice(deviceId);
  const status = device ? deviceStatusView(device.status) : null;
  return (
    <SimpleTooltip tip={deviceTitle(name, status)}>
      <span className="inline-flex min-w-0 items-center gap-1">
        <DeviceLead icon={icon} tone={status?.tone} size="xs" />
        <span className="truncate">{name}</span>
      </span>
    </SimpleTooltip>
  );
}

// A worktree by name, linking to its page on the device holding it,
// with its project after it. Read off the same cached lists the
// sidebar keeps, so a row costs no read of its own. A worktree the
// device no longer lists (removed mid-run) is named as such.
export function WorktreeRef({
  deviceId,
  api,
  projectId,
  worktreeId,
}: {
  deviceId: string;
  api: HostApi | undefined;
  projectId: string;
  worktreeId: string;
}) {
  const scope = { deviceId, api };
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
    <>
      {worktree ? (
        <Link
          to={WORKTREE_ROUTE_PATHS.detail}
          params={{ deviceId, projectId, worktreeId }}
          className="truncate font-medium text-foreground hover:underline"
        >
          {worktree.name}
        </Link>
      ) : (
        <span className="truncate italic">a removed worktree</span>
      )}
      {project && (
        <>
          <Sep />
          <span className="truncate text-muted-foreground">{project.name}</span>
        </>
      )}
    </>
  );
}
