// The Live page's rows, built the way the Tidy page builds its own: a
// mark, a title line, a detail line naming the worktree as
// "project / worktree", and text actions at the end. One component per
// kind of live thing, each with what can be done about it in place. A
// script: its console (which takes up the run's output whichever
// window or device started it, hooks/scripts/useScriptRunner.ts), a
// restart and a stop, and the worktree's ports that answer, opened
// here or forwarded from a peer. A forward: its local address, the
// worktree's Ports dialog to move it, and its stop. A mirror: its
// status and its manage dialog, under the device running it, as the
// worktree's own Mirror button opens it.
import type React from "react";
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  ArrowLeftRight,
  Cable,
  ExternalLink as ExternalLinkIcon,
  Loader2,
  Plus,
  RefreshCw,
} from "lucide-react";
import type { PortForwardSummary } from "@shared/ipc/modules/portForward";
import type { Project, RunningScript, Worktree } from "@shared/schemas";
import { DeviceGlyph } from "@/components/shared/DeviceGlyph";
import { ProjectIcon } from "@/components/shared/ProjectIcon";
import { Button } from "@/components/ui/button";
import { ChipButton } from "@/components/ui/chip-button";
import { ExternalLink } from "@/components/ui/external-link";
import { TONE_TEXT } from "@/components/ui/status-dot";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { RunnerScope } from "@/components/worktreeDetail/mirror/MirrorAction";
import { MirrorManageDialog } from "@/components/worktreeDetail/mirror/MirrorManageDialog";
import { describeMirror } from "@/components/worktreeDetail/mirror/mirrorStatus";
import { useMirrorView } from "@/components/worktreeDetail/mirror/useMirrorView";
import { PortsDialog } from "@/components/worktreeDetail/ports/PortsDialog";
import type { LiveMirror } from "@/hooks/live/useLiveActivity";
import { useWorktreePorts } from "@/hooks/ports/useWorktreePorts";
import { projectsQueryOptions } from "@/hooks/projects/useProjects";
import { commandAccessOf } from "@/hooks/remote/useCommandAccess";
import { useDeviceApi } from "@/hooks/remote/useDeviceApi";
import {
  type HostApi,
  MaybeHostScope,
  useHostScope,
} from "@/hooks/remote/useHostScope";
import {
  canForwardPorts,
  usePortForwardControl,
} from "@/hooks/remote/usePortForwards";
import {
  useDeviceIcon,
  useDeviceProperName,
  useRemoteDevice,
} from "@/hooks/remote/useRemoteDevices";
import { useDeviceScriptRunState } from "@/hooks/scripts/useScriptRuns";
import { useNow } from "@/hooks/ui/useNow";
import { worktreesQueryOptions } from "@/hooks/worktrees/useWorktrees";
import { pluralize } from "@/lib/pluralize";
import { formatRelativeTime } from "@/lib/relativeTime";
import { WORKTREE_ROUTE_PATHS } from "@/lib/routePaths";
import { cn } from "@/lib/utils";
import {
  scriptKey,
  scriptRunsFor,
  slotLabel,
  slotToParam,
} from "@/store/scriptRuns";

// A bordered list of rows, as the Tidy page lists its worktrees.
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

// One row: a mark, the title line, the detail line under it, and the
// actions at the end, which drop under the text when the row is too
// narrow for both (a phone).
function LiveRow({
  mark,
  title,
  detail,
  actions,
}: {
  mark: React.ReactNode;
  title: React.ReactNode;
  detail: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-3 text-sm">
      <div className="flex min-w-0 flex-1 basis-64 items-start gap-3">
        <span className="flex h-5 w-4 shrink-0 items-center justify-center">
          {mark}
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            {title}
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground">
            {detail}
          </div>
        </div>
      </div>
      {actions && (
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {actions}
        </div>
      )}
    </li>
  );
}

function Sep() {
  return <span aria-hidden>·</span>;
}

// A device by its glyph and name, as a detail.
function DeviceName({ deviceId }: { deviceId: string }) {
  const icon = useDeviceIcon(deviceId);
  const name = useDeviceProperName(deviceId);
  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      <DeviceGlyph icon={icon} className="size-3" />
      <span className="truncate">{name}</span>
    </span>
  );
}

function Ago({ at, prefix }: { at: number; prefix: string }) {
  const now = useNow();
  return (
    <SimpleTooltip tip={new Date(at).toLocaleString()}>
      <span className="tabular shrink-0">
        {prefix} {formatRelativeTime(at, now)}
      </span>
    </SimpleTooltip>
  );
}

// The worktree a row is about, off the same cached lists the sidebar
// keeps: undefined while they load, or for one the device no longer
// lists (removed while something still ran there).
function useLiveWorktree(
  deviceId: string,
  projectId: string | null,
  worktreeId: string,
): { project: Project | undefined; worktree: Worktree | undefined } {
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
  return { project, worktree };
}

// "project / worktree" with the project's icon, the way the Tidy page
// names a worktree, the worktree the way to its page.
function WorktreeName({
  deviceId,
  projectId,
  worktreeId,
  className,
}: {
  deviceId: string;
  projectId: string;
  worktreeId: string;
  className?: string;
}) {
  const { project, worktree } = useLiveWorktree(
    deviceId,
    projectId,
    worktreeId,
  );
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5", className)}>
      <ProjectIcon
        projectId={projectId}
        name={project?.name ?? "?"}
        deviceId={deviceId}
        className="size-3"
      />
      <span className="min-w-0 truncate">
        {project && (
          <>
            <span>{project.name}</span>
            <span aria-hidden className="px-1 text-muted-foreground/60">
              /
            </span>
          </>
        )}
        {worktree ? (
          <SimpleTooltip tip={`Open ${worktree.branch}`}>
            <Link
              to={WORKTREE_ROUTE_PATHS.detail}
              params={{ deviceId, projectId, worktreeId }}
              className="font-medium text-foreground underline-offset-2 hover:underline"
            >
              {worktree.name}
            </Link>
          </SimpleTooltip>
        ) : (
          <span className="italic">a removed worktree</span>
        )}
      </span>
    </span>
  );
}

// ---- scripts ----

export function ScriptRow({
  deviceId,
  api,
  run,
  showDevice,
  showPorts,
}: {
  deviceId: string;
  api: HostApi;
  run: RunningScript;
  showDevice: boolean;
  // The worktree's ports go on its first script's row alone, so two
  // scripts in one worktree do not both list them.
  showPorts: boolean;
}) {
  const navigate = useNavigate();
  const store = scriptRunsFor(deviceId);
  const key = scriptKey(run.projectId, run.worktreeId, run.slot);
  const state = useDeviceScriptRunState(deviceId, key);
  const held = state.runId === run.runId;
  const { canCommand } = commandAccessOf(deviceId, useRemoteDevice(deviceId));
  const stopRun = async () => {
    if (held) await store.cancel(key);
    else await api.scripts.cancel(run.runId);
  };
  const stop = useMutation({
    mutationFn: stopRun,
    meta: { errorTitle: "Couldn't stop the script" },
  });
  // A package script starts again the way its button starts it. The
  // lifecycle scripts belong to a create or a removal, so they only
  // stop.
  const restart = useMutation({
    mutationFn: async () => {
      if (run.slot.kind !== "package") return;
      const scriptName = run.slot.name;
      await stopRun();
      await store.run({
        key,
        worktreeId: run.worktreeId,
        slot: run.slot,
        runner: () =>
          api.packageScripts.run({
            projectId: run.projectId,
            worktreeId: run.worktreeId,
            scriptName,
          }),
      });
    },
    meta: { errorTitle: "Couldn't restart the script" },
  });
  const stopping = stop.isPending || state.cancelling;
  const label = slotLabel(run.slot);
  return (
    <MaybeHostScope deviceId={deviceId} api={api}>
      <LiveRow
        mark={
          <span
            aria-hidden
            className="size-2 animate-pulse rounded-full bg-emerald-500"
          />
        }
        title={
          <>
            <span
              className={cn(
                "min-w-0 truncate font-medium",
                run.slot.kind === "package" && "font-mono",
              )}
            >
              {label}
            </span>
            {showPorts && (
              <WorktreePorts
                deviceId={deviceId}
                worktree={{ projectId: run.projectId, id: run.worktreeId }}
              />
            )}
          </>
        }
        detail={
          <>
            <WorktreeName
              deviceId={deviceId}
              projectId={run.projectId}
              worktreeId={run.worktreeId}
            />
            {showDevice && (
              <>
                <Sep />
                <DeviceName deviceId={deviceId} />
              </>
            )}
            <Sep />
            <Ago at={run.startedAt} prefix="started" />
          </>
        }
        actions={
          <>
            <Button
              size="xs"
              variant="ghost"
              onClick={() =>
                void navigate({
                  to: WORKTREE_ROUTE_PATHS.script,
                  params: {
                    deviceId,
                    projectId: run.projectId,
                    worktreeId: run.worktreeId,
                    scriptKey: slotToParam(run.slot),
                  },
                })
              }
            >
              Output
            </Button>
            {canCommand && run.slot.kind === "package" && (
              <Button
                size="xs"
                variant="ghost"
                disabled={stopping || restart.isPending}
                onClick={() => restart.mutate()}
              >
                {restart.isPending ? "Restarting…" : "Restart"}
              </Button>
            )}
            {canCommand && (
              <Button
                size="xs"
                variant="ghost-destructive"
                disabled={stopping || restart.isPending}
                onClick={() => stop.mutate()}
              >
                {stopping ? "Stopping…" : "Stop"}
              </Button>
            )}
          </>
        }
      />
    </MaybeHostScope>
  );
}

// The worktree's ports that answer right now, beside its script: on
// this machine a link to each, on a peer the forward that brings it
// here (or, once on, the link to it).
function WorktreePorts({
  deviceId,
  worktree,
}: {
  deviceId: string;
  worktree: { projectId: string; id: string };
}) {
  const { remote } = useHostScope();
  const ports = useWorktreePorts(worktree).data?.ports ?? [];
  return ports
    .filter((port) => port.listening)
    .map((port) =>
      remote ? (
        <PeerPort
          key={port.port}
          deviceId={deviceId}
          port={port.port}
          worktree={worktree}
        />
      ) : (
        <LocalhostLink key={port.port} port={port.port} />
      ),
    );
}

function LocalhostLink({ port }: { port: number }) {
  return (
    <SimpleTooltip tip={`Open localhost:${port}`}>
      <span className="inline-flex">
        <ExternalLink
          href={`http://localhost:${port}`}
          errorTitle="Couldn't open the port"
          className="inline-flex items-center gap-1 font-mono text-xs text-muted-foreground no-underline hover:text-foreground"
        >
          localhost:{port}
          <ExternalLinkIcon aria-hidden className="size-3" />
        </ExternalLink>
      </span>
    </SimpleTooltip>
  );
}

// A peer's port: its local link once this machine forwards it, else a
// one-click forward to the same local port (the Ports dialog picks
// another). A browser binds no ports, so there it is only named.
function PeerPort({
  deviceId,
  port,
  worktree,
}: {
  deviceId: string;
  port: number;
  worktree: { projectId: string; id: string };
}) {
  const control = usePortForwardControl(deviceId, port, {
    projectId: worktree.projectId,
    worktreeId: worktree.id,
  });
  if (control.forward)
    return <LocalhostLink port={control.forward.localPort} />;
  if (!canForwardPorts) {
    return (
      <span className="font-mono text-xs text-muted-foreground">:{port}</span>
    );
  }
  return (
    <SimpleTooltip tip={control.error ?? `Reach ${port} at localhost here`}>
      <ChipButton
        disabled={control.isPending}
        onClick={() => control.apply({ on: true, localPort: port })}
        className={cn("py-0.5", control.error && "text-destructive")}
      >
        {control.isPending ? (
          <Loader2 aria-hidden className="size-3 animate-spin" />
        ) : (
          <Plus aria-hidden className="size-3" />
        )}
        Forward <span className="font-mono">{port}</span>
      </ChipButton>
    </SimpleTooltip>
  );
}

// ---- forwards ----

export function ForwardRow({
  forward,
  stopping,
  onStop,
}: {
  forward: PortForwardSummary;
  stopping: boolean;
  onStop: () => void;
}) {
  const [open, setOpen] = useState(false);
  const { api } = useDeviceApi(forward.deviceId);
  const from = forward.worktree;
  const { worktree } = useLiveWorktree(
    forward.deviceId,
    from?.projectId ?? null,
    from?.worktreeId ?? "",
  );
  const deviceName = useDeviceProperName(forward.deviceId);
  return (
    <LiveRow
      mark={<Cable aria-hidden className="size-4 text-muted-foreground" />}
      title={
        <>
          <SimpleTooltip tip={`Open localhost:${forward.localPort}`}>
            <span className="inline-flex">
              <ExternalLink
                href={`http://localhost:${forward.localPort}`}
                errorTitle="Couldn't open the forwarded port"
                className="inline-flex items-center gap-1 font-mono font-medium no-underline hover:underline"
              >
                localhost:{forward.localPort}
                <ExternalLinkIcon
                  aria-hidden
                  className="size-3 text-muted-foreground"
                />
              </ExternalLink>
            </span>
          </SimpleTooltip>
          <span className="font-mono text-xs text-muted-foreground">
            ← {deviceName}:{forward.remotePort}
          </span>
        </>
      }
      detail={
        <>
          {from ? (
            <WorktreeName
              deviceId={forward.deviceId}
              projectId={from.projectId}
              worktreeId={from.worktreeId}
            />
          ) : (
            <DeviceName deviceId={forward.deviceId} />
          )}
          <Sep />
          <span
            className={cn(
              "shrink-0",
              forward.connCount > 0 && TONE_TEXT.emerald,
            )}
          >
            {forward.connCount > 0
              ? pluralize(forward.connCount, "open connection")
              : "No open connections"}
          </span>
        </>
      }
      actions={
        <>
          {worktree && api && (
            <Button size="xs" variant="ghost" onClick={() => setOpen(true)}>
              Change port
            </Button>
          )}
          <Button
            size="xs"
            variant="ghost-destructive"
            disabled={stopping}
            onClick={onStop}
          >
            {stopping ? "Stopping…" : "Stop"}
          </Button>
          {open && worktree && api && (
            <MaybeHostScope deviceId={forward.deviceId} api={api}>
              <PortsDialog worktree={worktree} onClose={() => setOpen(false)} />
            </MaybeHostScope>
          )}
        </>
      }
    />
  );
}

// ---- mirrors ----

export function MirrorRow({
  mirror,
  showDevice,
}: {
  mirror: LiveMirror;
  showDevice: boolean;
}) {
  return mirror.kind === "session" ? (
    <SessionRow mirror={mirror} />
  ) : (
    <LiveRow
      mark={
        <RefreshCw aria-hidden className={cn("size-4", TONE_TEXT.emerald)} />
      }
      title={
        <>
          <WorktreeName
            deviceId={mirror.copyDeviceId}
            projectId={mirror.stream.projectId}
            worktreeId={mirror.stream.worktreeId}
            className="text-sm text-muted-foreground"
          />
          <span className={cn("text-xs", TONE_TEXT.emerald)}>Mirrored</span>
        </>
      }
      detail={
        <>
          <span className="shrink-0">a copy kept by</span>
          <DeviceName deviceId={mirror.stream.peerDeviceId} />
          {showDevice && (
            <>
              <span className="shrink-0">on</span>
              <DeviceName deviceId={mirror.copyDeviceId} />
            </>
          )}
          <Sep />
          <Ago at={mirror.stream.since} prefix="since" />
        </>
      }
    />
  );
}

function SessionRow({
  mirror,
}: {
  mirror: Extract<LiveMirror, { kind: "session" }>;
}) {
  const { session, runnerDeviceId, runnerApi, engine } = mirror;
  const [open, setOpen] = useState(false);
  // The runner going away takes the dialog with it.
  if (open && runnerApi === undefined) setOpen(false);
  const managed = useMirrorView(
    {
      runnerDeviceId,
      runnerApi,
      otherDeviceId: session.deviceId,
      session,
      engine,
    },
    session,
  );
  const view = describeMirror(session, {
    runnerAway: runnerApi === undefined ? managed.names.runner : undefined,
    engine,
  });
  return (
    <LiveRow
      mark={
        <RefreshCw
          aria-hidden
          className={cn(
            "size-4",
            TONE_TEXT[view.tone],
            view.spinning && "animate-spin",
          )}
        />
      }
      title={
        <>
          <WorktreeName
            deviceId={runnerDeviceId}
            projectId={session.localProjectId}
            worktreeId={session.localWorktreeId}
            className="text-sm text-muted-foreground"
          />
          <SimpleTooltip tip={view.detail || undefined}>
            <span className={cn("text-xs", TONE_TEXT[view.tone])}>
              {view.label}
            </span>
          </SimpleTooltip>
        </>
      }
      detail={
        <>
          <DeviceName deviceId={runnerDeviceId} />
          <ArrowLeftRight
            aria-label="kept in step with"
            className="size-3 shrink-0"
          />
          <DeviceName deviceId={session.deviceId} />
          {view.detail && (
            <>
              <Sep />
              <span className="min-w-0 truncate">{view.detail}</span>
            </>
          )}
          <Sep />
          <Ago at={session.createdAt} prefix="since" />
        </>
      }
      actions={
        <>
          <SimpleTooltip
            tip={runnerApi === undefined ? view.detail : undefined}
          >
            <Button
              size="xs"
              variant="ghost"
              disabled={runnerApi === undefined}
              onClick={() => setOpen(true)}
            >
              Manage
            </Button>
          </SimpleTooltip>
          {open && runnerApi !== undefined && (
            <RunnerScope deviceId={runnerDeviceId} api={runnerApi}>
              <MirrorManageDialog
                session={session}
                {...managed}
                onClose={() => setOpen(false)}
                onStopped={() => setOpen(false)}
              />
            </RunnerScope>
          )}
        </>
      }
    />
  );
}
