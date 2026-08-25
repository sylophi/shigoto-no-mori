import { getRouteApi } from "@tanstack/react-router";
import { FolderGit2 } from "lucide-react";
import { errorMessageOf } from "@shared/errors";
import type { Project, Worktree } from "@shared/schemas";
import { BranchLabel } from "@/components/ui/branch-label";
import { WorktreeKindIcon } from "@/components/WorktreeKindIcon";
import { DeviceStatusDot } from "./DeviceStatusDot";
import {
  useAllRemoteWorktrees,
  useRemoteProjects,
} from "@/hooks/remote/useRemoteForest";
import { useRemoteDevices } from "@/hooks/remote/useRemoteDevices";
import { deviceStatusView } from "@/lib/remote/deviceStatus";
import { deviceVersionMismatch } from "@/lib/remote/devices";

const route = getRouteApi("/devices/$deviceId");

// Read-only view of another machine's forest (v2 step 3, slice C). Over
// the account relay the read-only guarantee is now transport-enforced
// for mutations (slice D): the host refuses a peer's mutating call
// unless it has explicitly granted that peer command access, so a
// mutating channel that never reaches this page's UI cannot be reached
// by hand either. This page additionally renders no mutation control:
// no create, quick-create, delete, land, convert, relocate or reorder
// here, and no worktree-detail write surface. It shows every project and
// every worktree, nothing more. Note the LAN socket has no grant model
// (a LAN peer is a single trusted token), so over LAN the read-only
// property is still this page's no-mutation-control convention alone.
export function RemoteForest() {
  const { deviceId } = route.useParams();
  const devices = useRemoteDevices();
  // The registry holds both LAN and relay entries, and a stale LAN entry
  // (api undefined, in backoff) can share a deviceId with a live relay
  // entry for the same machine. Prefer a SERVING entry so that stale twin
  // does not shadow the live one and strand this page (I2). Guard the
  // empty id explicitly: an unconnected entry also carries "", so
  // matching on it would pick an arbitrary disconnected device.
  const device =
    deviceId === ""
      ? undefined
      : (devices.find((d) => d.deviceId === deviceId && d.api !== undefined) ??
        devices.find((d) => d.deviceId === deviceId));

  if (device === undefined) {
    return (
      <ForestShell title="Remote forest">
        <EmptyPanel>
          This device isn&apos;t connected. Open Settings to add or reconnect
          it, then try again.
        </EmptyPanel>
      </ForestShell>
    );
  }

  return <ConnectedForest device={device} deviceId={deviceId} />;
}

function ConnectedForest({
  device,
  deviceId,
}: {
  device: ReturnType<typeof useRemoteDevices>[number];
  deviceId: string;
}) {
  const api = device.api;
  const {
    data: projects = [],
    isPending,
    isError,
    error,
  } = useRemoteProjects(deviceId, api);
  const worktreeQueries = useAllRemoteWorktrees(deviceId, api, projects);
  const worktreesByProject = new Map<string, Worktree[]>(
    projects.map((project, index) => [
      project.id,
      worktreeQueries[index]?.data ?? [],
    ]),
  );

  const { connected } = deviceStatusView(device.status);
  const mismatch = deviceVersionMismatch(device);

  return (
    <ForestShell
      title={device.label}
      status={<DeviceStatusDot status={device.status} />}
    >
      {mismatch && (
        <p className="text-xs text-amber-500">
          This device is running a different app version. Update the other
          machine if something looks off.
        </p>
      )}

      {!connected ? (
        <EmptyPanel>
          {device.status.phase === "blocked"
            ? `Can't connect: ${device.status.message}.`
            : // The honest phase label, not a blanket "Connecting" that
              // lies for a stopped or backing-off device (I4).
              deviceStatusView(device.status).label}
        </EmptyPanel>
      ) : isPending ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : isError ? (
        // remoteProjectsQueryOptions sets silentError expecting the
        // forest to render its own inline error, so a failed query shows
        // the reason rather than a misleading empty "No projects" (I4).
        <EmptyPanel>
          Couldn&apos;t load this device&apos;s forest: {errorMessageOf(error)}
        </EmptyPanel>
      ) : projects.length === 0 ? (
        <EmptyPanel>No projects on this device yet.</EmptyPanel>
      ) : (
        <div className="flex flex-col gap-4">
          {projects.map((project) => (
            <RemoteProjectGroup
              key={project.id}
              project={project}
              worktrees={worktreesByProject.get(project.id) ?? []}
            />
          ))}
        </div>
      )}
    </ForestShell>
  );
}

function RemoteProjectGroup({
  project,
  worktrees,
}: {
  project: Project;
  worktrees: Worktree[];
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <FolderGit2 className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate">{project.name}</span>
        <span className="shrink-0 text-[10px] text-muted-foreground/70">
          {worktrees.length}
        </span>
      </div>
      {worktrees.length === 0 ? (
        <p className="px-2 text-xs text-muted-foreground/70">No worktrees.</p>
      ) : (
        <div className="divide-y divide-border overflow-hidden rounded-md border border-border">
          {worktrees.map((worktree) => (
            <RemoteWorktreeRow key={worktree.id} worktree={worktree} />
          ))}
        </div>
      )}
    </div>
  );
}

// Display-only row: the local WorktreeRow navigates to local routes and
// reads local PR state, so a device-scoped view reuses only the pure
// display primitives (BranchLabel, WorktreeKindIcon) with no click
// target and no action cluster.
function RemoteWorktreeRow({ worktree }: { worktree: Worktree }) {
  return (
    <div className="flex items-center gap-2 px-2 py-1 text-xs">
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-mono">
          <BranchLabel branch={worktree.branch} detached={worktree.detached} />
        </span>
        <span className="truncate text-[10px] text-muted-foreground">
          {worktree.name}
        </span>
      </div>
      {(worktree.ahead > 0 || worktree.behind > 0) && (
        <span className="tabular shrink-0 text-[10px] text-muted-foreground/70">
          {worktree.ahead > 0 && `↑${worktree.ahead}`}
          {worktree.ahead > 0 && worktree.behind > 0 && " "}
          {worktree.behind > 0 && `↓${worktree.behind}`}
        </span>
      )}
      <WorktreeKindIcon worktree={worktree} />
    </div>
  );
}

function ForestShell({
  title,
  status,
  children,
}: {
  title: string;
  status?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-full flex-col">
      <header className="relative flex items-center gap-3 overflow-hidden border-b border-border px-6 pt-7 pb-4">
        <div className="relative z-[1] flex min-w-0 flex-col">
          <span className="truncate text-xs text-muted-foreground">
            Remote device
          </span>
          <h1 className="truncate text-lg font-medium tracking-tight">
            {title}
          </h1>
        </div>
        {status && <div className="relative z-[1] shrink-0">{status}</div>}
        <span
          aria-hidden
          className="doubutsu-only pointer-events-none absolute -top-6 right-2 text-[120px] leading-none font-black text-[var(--doubutsu-watermark)] opacity-10 select-none"
        >
          端末
        </span>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <div className="flex max-w-3xl flex-col gap-6">{children}</div>
      </div>
    </div>
  );
}

function EmptyPanel({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}
