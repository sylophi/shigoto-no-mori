// The live things a card lists, one line each, with what can be done
// about them on the line itself. A script: its name opens its console
// (which takes up the run's output whichever window started it,
// hooks/scripts/useScriptRunner.ts), and it restarts and stops in
// place. A mirror: how it is doing, and its manage dialog (status,
// history, pause, the ignore rule, stop) opened under the device
// running it, as the worktree's Mirror button does. A forward: the
// local address it answers on (a click opens it), the worktree's
// Ports dialog to move it to another local port, and its stop, which
// never needs the peer.
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  Cable,
  Loader2,
  Plug,
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
import { ExternalLink } from "@/components/ui/external-link";
import { IconButton } from "@/components/ui/icon-button";
import { TONE_TEXT } from "@/components/ui/status-dot";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { RunnerScope } from "@/components/worktreeDetail/mirror/MirrorAction";
import { MirrorManageDialog } from "@/components/worktreeDetail/mirror/MirrorManageDialog";
import { describeMirror } from "@/components/worktreeDetail/mirror/mirrorStatus";
import { useMirrorView } from "@/components/worktreeDetail/mirror/useMirrorView";
import { PortsDialog } from "@/components/worktreeDetail/ports/PortsDialog";
import type { LiveMirror } from "@/hooks/live/useLiveActivity";
import { commandAccessOf } from "@/hooks/remote/useCommandAccess";
import type { HostApi } from "@/hooks/remote/useHostScope";
import {
  useDeviceIcon,
  useDeviceProperName,
  useRemoteDevice,
} from "@/hooks/remote/useRemoteDevices";
import { useDeviceScriptRunState } from "@/hooks/scripts/useScriptRuns";
import { useNow } from "@/hooks/ui/useNow";
import { pluralize } from "@/lib/pluralize";
import { WORKTREE_ROUTE_PATHS } from "@/lib/routePaths";
import { cn } from "@/lib/utils";
import {
  scriptKey,
  scriptRunsFor,
  slotLabel,
  slotToParam,
} from "@/store/scriptRuns";
import { LiveLine } from "./LiveCard";

// How long something has been up, coarse like the app's relative
// times: "just now", "12m", "3h 5m", "2d".
function uptime(since: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - since) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  }
  return `${Math.floor(hours / 24)}d`;
}

function Uptime({ since }: { since: number }) {
  const now = useNow();
  return (
    <SimpleTooltip tip={`Since ${new Date(since).toLocaleString()}`}>
      <span className="tabular shrink-0">{uptime(since, now)}</span>
    </SimpleTooltip>
  );
}

// A device inline in a line: its glyph and its name.
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

// The words a line's leading control takes: a button set as text.
const LINE_LINK =
  "min-w-0 truncate rounded-sm font-medium underline-offset-2 hover:underline";

export function ScriptLine({
  deviceId,
  api,
  run,
}: {
  deviceId: string;
  api: HostApi;
  run: RunningScript;
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
  const cancel = useMutation({
    mutationFn: stopRun,
    meta: { errorTitle: "Couldn't stop the script" },
  });
  // A package script runs again the way its button starts it. The
  // lifecycle scripts belong to a create or a removal, so they only
  // stop.
  const restart = useMutation({
    mutationFn: async () => {
      if (run.slot.kind !== "package") return;
      const name = run.slot.name;
      await stopRun();
      await store.run({
        key,
        worktreeId: run.worktreeId,
        slot: run.slot,
        runner: () =>
          api.packageScripts.run({
            projectId: run.projectId,
            worktreeId: run.worktreeId,
            scriptName: name,
          }),
      });
    },
    meta: { errorTitle: "Couldn't restart the script" },
  });
  const stopping = cancel.isPending || state.cancelling;
  const busy = stopping || restart.isPending;
  const label = slotLabel(run.slot);
  const openConsole = () =>
    void navigate({
      to: WORKTREE_ROUTE_PATHS.script,
      params: {
        deviceId,
        projectId: run.projectId,
        worktreeId: run.worktreeId,
        scriptKey: slotToParam(run.slot),
      },
    });
  return (
    <LiveLine
      mark={
        <span
          aria-hidden
          className="size-1.5 animate-pulse rounded-full bg-emerald-500"
        />
      }
      label={
        <SimpleTooltip tip="View output">
          <button
            type="button"
            onClick={openConsole}
            className={cn(
              LINE_LINK,
              run.slot.kind === "package" && "font-mono",
            )}
          >
            {label}
          </button>
        </SimpleTooltip>
      }
      meta={<Uptime since={run.startedAt} />}
      actions={
        <>
          <SimpleTooltip tip="View output">
            <IconButton
              aria-label={`View ${label}'s output`}
              onClick={openConsole}
            >
              <SquareTerminal className="size-3.5" />
            </IconButton>
          </SimpleTooltip>
          {canCommand && run.slot.kind === "package" && (
            <SimpleTooltip tip="Restart">
              <IconButton
                aria-label={`Restart ${label}`}
                disabled={busy}
                onClick={() => restart.mutate()}
              >
                <RotateCw
                  className={cn(
                    "size-3.5",
                    restart.isPending && "animate-spin",
                  )}
                />
              </IconButton>
            </SimpleTooltip>
          )}
          {canCommand && (
            <SimpleTooltip tip={stopping ? "Stopping…" : "Stop"}>
              <IconButton
                tone="destructive"
                aria-label={`Stop ${label}`}
                disabled={busy}
                onClick={() => cancel.mutate()}
              >
                {stopping ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Square className="size-3 fill-current" />
                )}
              </IconButton>
            </SimpleTooltip>
          )}
        </>
      }
    />
  );
}

export function MirrorLine({ mirror }: { mirror: LiveMirror }) {
  return mirror.kind === "session" ? (
    <SessionLine mirror={mirror} />
  ) : (
    <LiveLine
      mark={
        <RefreshCw aria-hidden className={cn("size-3.5", TONE_TEXT.emerald)} />
      }
      label={
        <>
          <span className="shrink-0">Mirrored from</span>
          <DeviceName deviceId={mirror.stream.peerDeviceId} />
        </>
      }
      meta={<Uptime since={mirror.stream.since} />}
    />
  );
}

function SessionLine({
  mirror,
}: {
  mirror: Extract<LiveMirror, { kind: "session" }>;
}) {
  const { session, runnerDeviceId, runnerApi, engine } = mirror;
  const [open, setOpen] = useState(false);
  // The runner going away takes the dialog with it.
  if (open && runnerApi === undefined) setOpen(false);
  const link = {
    runnerDeviceId,
    runnerApi,
    otherDeviceId: session.deviceId,
    session,
    engine,
  };
  const managed = useMirrorView(link, session);
  const view = describeMirror(session, {
    runnerAway: runnerApi === undefined ? managed.names.runner : undefined,
    engine,
  });
  const manage = runnerApi === undefined ? undefined : () => setOpen(true);
  return (
    <>
      <LiveLine
        mark={
          <RefreshCw
            aria-hidden
            className={cn(
              "size-3.5",
              TONE_TEXT[view.tone],
              view.spinning && "animate-spin",
            )}
          />
        }
        label={
          <>
            <span className="shrink-0">Mirrored to</span>
            <DeviceName deviceId={session.deviceId} />
          </>
        }
        meta={
          <SimpleTooltip tip={view.detail || undefined}>
            <span className={cn("shrink-0", TONE_TEXT[view.tone])}>
              {view.label}
            </span>
          </SimpleTooltip>
        }
        actions={
          <SimpleTooltip tip={manage ? "Manage the mirror" : view.detail}>
            <IconButton
              aria-label="Manage the mirror"
              disabled={manage === undefined}
              onClick={manage}
            >
              <Settings2 className="size-3.5" />
            </IconButton>
          </SimpleTooltip>
        }
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

export function ForwardLine({
  forward,
  worktree,
  showDevice,
  stopping,
  onStop,
}: {
  forward: PortForwardSummary;
  // The worktree it was switched on from, whose Ports dialog moves it.
  worktree: Worktree | undefined;
  // On the loose ports' card, where no worktree says whose port it is.
  showDevice: boolean;
  stopping: boolean;
  onStop: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <LiveLine
        mark={<Cable aria-hidden className="size-3.5 text-muted-foreground" />}
        label={
          <SimpleTooltip tip={`Open localhost:${forward.localPort}`}>
            <span className="inline-flex min-w-0">
              <ExternalLink
                href={`http://localhost:${forward.localPort}`}
                errorTitle="Couldn't open the forwarded port"
                className={cn(LINE_LINK, "font-mono no-underline")}
              >
                localhost:{forward.localPort}
              </ExternalLink>
            </span>
          </SimpleTooltip>
        }
        meta={
          <>
            <span className="shrink-0 font-mono">→ {forward.remotePort}</span>
            {showDevice && (
              <>
                <span className="shrink-0">on</span>
                <DeviceName deviceId={forward.deviceId} />
              </>
            )}
            {forward.connCount > 0 && (
              <SimpleTooltip
                tip={pluralize(forward.connCount, "open connection")}
              >
                <span className="tabular inline-flex shrink-0 items-center gap-0.5">
                  <Plug aria-hidden className="size-3" />
                  {forward.connCount}
                </span>
              </SimpleTooltip>
            )}
          </>
        }
        actions={
          <>
            {worktree && (
              <SimpleTooltip tip="Change the local port">
                <IconButton
                  aria-label={`Change the local port for ${forward.remotePort}`}
                  onClick={() => setOpen(true)}
                >
                  <Settings2 className="size-3.5" />
                </IconButton>
              </SimpleTooltip>
            )}
            <SimpleTooltip tip="Stop forwarding">
              <IconButton
                tone="destructive"
                aria-label={`Stop forwarding port ${forward.remotePort}`}
                disabled={stopping}
                onClick={onStop}
              >
                {stopping ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <X className="size-3.5" />
                )}
              </IconButton>
            </SimpleTooltip>
          </>
        }
      />
      {open && worktree && (
        <PortsDialog worktree={worktree} onClose={() => setOpen(false)} />
      )}
    </>
  );
}
