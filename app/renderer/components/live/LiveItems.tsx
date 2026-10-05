// The live things a card lists, one line each. A script: its name, how
// long it has run, its console (where this window holds the output:
// a run's output streams only to the window that started it) and its
// stop, on any device that lets this one command it. A mirror: the
// other device and how the mirror is doing, worded as the worktree
// header words it. A forward: the local address it answers on (a click
// opens it) and its stop, which never needs the peer.
import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  Cable,
  Loader2,
  Plug,
  RefreshCw,
  Square,
  SquareTerminal,
  X,
} from "lucide-react";
import type { PortForwardSummary } from "@shared/ipc/modules/portForward";
import type { RunningScript } from "@shared/schemas";
import { DeviceGlyph } from "@/components/shared/DeviceGlyph";
import { ExternalLink } from "@/components/ui/external-link";
import { IconButton } from "@/components/ui/icon-button";
import { TONE_TEXT } from "@/components/ui/status-dot";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { describeMirror } from "@/components/worktreeDetail/mirror/mirrorStatus";
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
  if (hours < 24)
    return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
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
  const key = scriptKey(run.projectId, run.worktreeId, run.slot);
  const state = useDeviceScriptRunState(deviceId, key);
  const held = state.runId === run.runId;
  const access = commandAccessOf(deviceId, useRemoteDevice(deviceId));
  const cancel = useMutation({
    mutationFn: async () => {
      if (held) await scriptRunsFor(deviceId).cancel(key);
      else await api.scripts.cancel(run.runId);
    },
    meta: { errorTitle: "Couldn't stop the script" },
  });
  const stopping = cancel.isPending || state.cancelling;
  const label = slotLabel(run.slot);
  return (
    <LiveLine
      mark={
        <span
          aria-hidden
          className="size-1.5 animate-pulse rounded-full bg-emerald-500"
        />
      }
      label={
        <span
          className={cn(
            "truncate font-medium",
            run.slot.kind === "package" && "font-mono",
          )}
        >
          {label}
        </span>
      }
      meta={<Uptime since={run.startedAt} />}
      actions={
        <>
          {held && (
            <SimpleTooltip tip="Open the console">
              <IconButton
                aria-label={`Open ${label}'s console`}
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
                <SquareTerminal className="size-3.5" />
              </IconButton>
            </SimpleTooltip>
          )}
          {access.canCommand && (
            <SimpleTooltip tip={stopping ? "Stopping…" : "Stop"}>
              <IconButton
                tone="destructive"
                aria-label={`Stop ${label}`}
                disabled={stopping}
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
  const runner = useDeviceProperName(mirror.runnerDeviceId);
  const view = describeMirror(mirror.session, {
    runnerAway: mirror.runnerApi === undefined ? runner : undefined,
    engine: mirror.engine,
  });
  return (
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
          <DeviceName deviceId={mirror.session.deviceId} />
        </>
      }
      meta={
        <SimpleTooltip tip={view.detail || undefined}>
          <span className={cn("shrink-0", TONE_TEXT[view.tone])}>
            {view.label}
          </span>
        </SimpleTooltip>
      }
    />
  );
}

export function ForwardLine({
  forward,
  showDevice,
  stopping,
  onStop,
}: {
  forward: PortForwardSummary;
  // On the loose ports' card, where no worktree says whose port it is.
  showDevice: boolean;
  stopping: boolean;
  onStop: () => void;
}) {
  return (
    <LiveLine
      mark={<Cable aria-hidden className="size-3.5 text-muted-foreground" />}
      label={
        <SimpleTooltip tip={`Open localhost:${forward.localPort}`}>
          <span className="inline-flex">
            <ExternalLink
              href={`http://localhost:${forward.localPort}`}
              errorTitle="Couldn't open the forwarded port"
              className="truncate font-mono font-medium no-underline hover:underline"
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
      }
    />
  );
}
