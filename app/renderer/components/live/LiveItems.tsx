// The live things a card lists, each a block with its status and its
// actions as labelled buttons (LiveBlock, at the end). A script: its output (the
// console takes up the run's output whichever window or device started
// it, hooks/scripts/useScriptRunner.ts), a restart and a stop. A
// mirror: how it is doing, and its manage dialog (status, history,
// pause, the ignore rule, stop) under the device running it, as the
// worktree's Mirror button opens it. A forward: the local address it
// answers on, the worktree's Ports dialog to move it to another local
// port, and its stop, which never needs the peer.
import type React from "react";
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  Cable,
  ExternalLink as ExternalLinkIcon,
  Loader2,
  RefreshCw,
  RotateCw,
  Settings2,
  Square,
  SquareTerminal,
  X,
} from "lucide-react";
import type { PortForwardSummary } from "@shared/ipc/modules/portForward";
import type { RunningScript, Worktree } from "@shared/schemas";
import { DeviceGlyph } from "@/components/shared/DeviceGlyph";
import { Button } from "@/components/ui/button";
import { StatusDot, TONE_TEXT } from "@/components/ui/status-dot";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { RunnerScope } from "@/components/worktreeDetail/mirror/MirrorAction";
import { MirrorManageDialog } from "@/components/worktreeDetail/mirror/MirrorManageDialog";
import { describeMirror } from "@/components/worktreeDetail/mirror/mirrorStatus";
import { useMirrorView } from "@/components/worktreeDetail/mirror/useMirrorView";
import { PortsDialog } from "@/components/worktreeDetail/ports/PortsDialog";
import type { LiveMirror } from "@/hooks/live/useLiveActivity";
import { usePortForwardStop } from "@/hooks/remote/usePortForwards";
import {
  useDeviceIcon,
  useDeviceProperName,
} from "@/hooks/remote/useRemoteDevices";
import { useScriptRunner } from "@/hooks/scripts/useScriptRunner";
import { useNow } from "@/hooks/ui/useNow";
import { openExternalUrl } from "@/lib/openExternal";
import { peerReadOnlyNote } from "@/lib/commandAccessCopy";
import { pluralize } from "@/lib/pluralize";
import { WORKTREE_ROUTE_PATHS } from "@/lib/routePaths";
import { cn } from "@/lib/utils";
import { slotLabel, slotToParam } from "@/store/scriptRuns";

// How long something has been up, coarse like the app's relative
// times: "up 12m", "up 3h 5m", "up 2d", or "just started".
function uptime(since: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - since) / 60_000);
  if (minutes < 1) return "just started";
  if (minutes < 60) return `up ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return minutes % 60 ? `up ${hours}h ${minutes % 60}m` : `up ${hours}h`;
  }
  return `up ${Math.floor(hours / 24)}d`;
}

function Uptime({ since }: { since: number }) {
  const now = useNow();
  return (
    <SimpleTooltip tip={`Started ${new Date(since).toLocaleString()}`}>
      <span className="tabular">{uptime(since, now)}</span>
    </SimpleTooltip>
  );
}

// A ghost button on an item's muted fill. v1's dark ghost hover is that
// same fill, so the hover lifts it the way the outline button does.
const ON_FILL = "dark:hover:bg-input/50";

// A device inline: its glyph and its name.
function DeviceName({ deviceId }: { deviceId: string }) {
  const icon = useDeviceIcon(deviceId);
  const name = useDeviceProperName(deviceId);
  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      <DeviceGlyph icon={icon} className="size-3.5" />
      <span className="truncate">{name}</span>
    </span>
  );
}

// Under the card's scope (LiveCard), so the runner reads and drives
// the run on the device it runs on, as a worktree's script row does.
export function ScriptItem({
  deviceId,
  run,
}: {
  deviceId: string;
  run: RunningScript;
}) {
  const navigate = useNavigate();
  const { state, canRun, start, stop } = useScriptRunner(
    { projectId: run.projectId, id: run.worktreeId },
    run.slot,
  );
  const deviceName = useDeviceProperName(deviceId);
  // A package script starts again the way its button starts it. The
  // lifecycle scripts belong to a create or a removal, so they only
  // stop.
  // Starts again only once the run is stopped: a start beside a run
  // that would not stop is a second dev server on the same port.
  const restart = useMutation({
    mutationFn: async () => {
      if (!(await stop())) throw new Error("The running script didn't stop.");
      await start();
    },
    meta: { errorTitle: "Couldn't restart the script" },
  });
  const stopping = state.cancelling;
  const busy = stopping || restart.isPending;
  const label = slotLabel(run.slot);
  return (
    <LiveBlock
      mark={<StatusDot tone="emerald" pulse />}
      title={
        <SimpleTooltip whenTruncated tip={label}>
          <span
            className={cn(
              "min-w-0 truncate font-medium",
              run.slot.kind === "package" && "font-mono",
            )}
          >
            {label}
          </span>
        </SimpleTooltip>
      }
      status={<Uptime since={run.startedAt} />}
      // A device that takes no commands from here lets nothing be done
      // about its runs, its output included (attaching rides the same
      // grant), so the block only says so.
      detail={
        canRun ? undefined : (
          <SimpleTooltip tip={peerReadOnlyNote(deviceName)}>
            <span>Read-only</span>
          </SimpleTooltip>
        )
      }
      actions={
        canRun && (
          <>
            <Button
              size="sm"
              variant="ghost"
              className={ON_FILL}
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
              <SquareTerminal />
              Output
            </Button>
            {run.slot.kind === "package" && (
              <Button
                size="sm"
                variant="ghost"
                className={ON_FILL}
                disabled={busy}
                onClick={() => restart.mutate()}
              >
                <RotateCw className={cn(restart.isPending && "animate-spin")} />
                {restart.isPending ? "Restarting…" : "Restart"}
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost-destructive"
              disabled={busy}
              onClick={() => void stop()}
            >
              {stopping ? (
                <Loader2 className="animate-spin" />
              ) : (
                <Square className="size-3 fill-current" />
              )}
              {stopping ? "Stopping…" : "Stop"}
            </Button>
          </>
        )
      }
    />
  );
}

export function MirrorItem({ mirror }: { mirror: LiveMirror }) {
  return mirror.kind === "session" ? (
    <SessionItem mirror={mirror} />
  ) : (
    <LiveBlock
      mark={
        <RefreshCw aria-hidden className={cn("size-4", TONE_TEXT.emerald)} />
      }
      title={
        <>
          <span className="shrink-0">Mirrored from</span>
          <DeviceName deviceId={mirror.stream.peerDeviceId} />
        </>
      }
      status={<Uptime since={mirror.stream.since} />}
    />
  );
}

function SessionItem({
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
      otherCopy: {
        projectId: session.projectId,
        worktreeId: session.worktreeId,
      },
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
    <>
      <LiveBlock
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
            <span className="shrink-0">Mirrored to</span>
            <DeviceName deviceId={session.deviceId} />
          </>
        }
        status={<span className={TONE_TEXT[view.tone]}>{view.label}</span>}
        actions={
          <SimpleTooltip
            tip={runnerApi === undefined ? view.detail : undefined}
          >
            <Button
              size="sm"
              variant="ghost"
              className={ON_FILL}
              disabled={runnerApi === undefined}
              onClick={() => setOpen(true)}
            >
              <Settings2 />
              Manage
            </Button>
          </SimpleTooltip>
        }
        detail={view.detail || undefined}
      />
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
  );
}

export function ForwardItem({
  forward,
  worktree,
}: {
  forward: PortForwardSummary;
  // The worktree it was switched on from, whose Ports dialog moves it.
  worktree: Worktree | undefined;
}) {
  const [open, setOpen] = useState(false);
  const stop = usePortForwardStop();
  const stopping = stop.isPending;
  const url = `http://localhost:${forward.localPort}`;
  return (
    <>
      <LiveBlock
        mark={<Cable aria-hidden className="size-4 text-muted-foreground" />}
        title={
          <span className="min-w-0 truncate font-mono font-medium">
            localhost:{forward.localPort}
          </span>
        }
        // The Ports dialog's own words for a forward in use.
        status={
          <SimpleTooltip
            tip={
              forward.connCount > 0
                ? pluralize(forward.connCount, "open connection")
                : "Nothing connected right now"
            }
          >
            <span
              className={cn(
                "tabular",
                forward.connCount > 0 && TONE_TEXT.emerald,
              )}
            >
              {forward.connCount > 0 ? `${forward.connCount} open` : "idle"}
            </span>
          </SimpleTooltip>
        }
        actions={
          <>
            <Button
              size="sm"
              variant="ghost"
              className={ON_FILL}
              onClick={() => openExternalUrl(url, "Couldn't open the port")}
            >
              <ExternalLinkIcon />
              Open
            </Button>
            {worktree && (
              <Button
                size="sm"
                variant="ghost"
                className={ON_FILL}
                onClick={() => setOpen(true)}
              >
                <Settings2 />
                Change port
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost-destructive"
              disabled={stopping}
              onClick={() => stop.mutate(forward.forwardId)}
            >
              {stopping ? <Loader2 className="animate-spin" /> : <X />}
              {stopping ? "Stopping…" : "Stop"}
            </Button>
          </>
        }
        // The port it reaches, when it is not the local one's number.
        // The card's device heading says on which device.
        detail={
          forward.remotePort !== forward.localPort ? (
            <span className="shrink-0">
              from <span className="font-mono">{forward.remotePort}</span>
            </span>
          ) : undefined
        }
      />
      {open && worktree && (
        <PortsDialog worktree={worktree} onClose={() => setOpen(false)} />
      )}
    </>
  );
}

// One live thing inside a card, as a block of two rows: what it is
// and how it stands (its mark, its name, the status at the end), then
// what can be done about it, as labelled buttons, with any further
// detail at the end of that row.
function LiveBlock({
  mark,
  title,
  status,
  actions,
  detail,
}: {
  mark: React.ReactNode;
  title: React.ReactNode;
  status?: React.ReactNode;
  actions?: React.ReactNode;
  detail?: React.ReactNode;
}) {
  return (
    <li className="flex flex-col gap-2 rounded-lg bg-muted/40 px-3 py-2.5 text-sm">
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="flex size-4 shrink-0 items-center justify-center">
          {mark}
        </span>
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          {title}
        </span>
        {status && (
          <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
            {status}
          </span>
        )}
      </div>
      {(actions || detail) && (
        // Under the title, so the buttons line up with the name above
        // them rather than with the mark. A phone has no room for the
        // indent: there the buttons share the row's width.
        <div className="-ml-2 flex min-w-0 flex-wrap items-center gap-x-1 gap-y-1 pl-6.5 phone:ml-0 phone:pl-0">
          {actions && (
            <span className="flex items-center gap-1 phone:grid phone:w-full phone:auto-cols-fr phone:grid-flow-col">
              {actions}
            </span>
          )}
          {detail && (
            <span className="ml-auto flex min-w-0 items-center gap-1 truncate pl-2 text-xs text-muted-foreground phone:ml-0 phone:pl-0">
              {detail}
            </span>
          )}
        </div>
      )}
    </li>
  );
}
