// The live things a card lists, each a block with its status and its
// actions as labelled buttons (LiveItem). A script: its output (the
// console takes up the run's output whichever window or device started
// it, hooks/scripts/useScriptRunner.ts), a restart and a stop. A
// mirror: how it is doing, and its manage dialog (status, history,
// pause, the ignore rule, stop) under the device running it, as the
// worktree's Mirror button opens it. A forward: the local address it
// answers on, the worktree's Ports dialog to move it to another local
// port, and its stop, which never needs the peer.
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
import { openExternalUrl } from "@/lib/openExternal";
import { pluralize } from "@/lib/pluralize";
import { WORKTREE_ROUTE_PATHS } from "@/lib/routePaths";
import { cn } from "@/lib/utils";
import {
  scriptKey,
  scriptRunsFor,
  slotLabel,
  slotToParam,
} from "@/store/scriptRuns";
import { LiveItem } from "./LiveCard";

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

export function ScriptItem({
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
  const busy = stopping || restart.isPending;
  const label = slotLabel(run.slot);
  return (
    <LiveItem
      mark={
        <span
          aria-hidden
          className="size-2 animate-pulse rounded-full bg-emerald-500"
        />
      }
      title={
        <span
          className={cn(
            "min-w-0 truncate font-medium",
            run.slot.kind === "package" && "font-mono",
          )}
        >
          {label}
        </span>
      }
      status={<Uptime since={run.startedAt} />}
      actions={
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
          {canCommand && run.slot.kind === "package" && (
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
          {canCommand && (
            <Button
              size="sm"
              variant="ghost-destructive"
              disabled={busy}
              onClick={() => stop.mutate()}
            >
              {stopping ? (
                <Loader2 className="animate-spin" />
              ) : (
                <Square className="size-3 fill-current" />
              )}
              {stopping ? "Stopping…" : "Stop"}
            </Button>
          )}
        </>
      }
    />
  );
}

export function MirrorItem({ mirror }: { mirror: LiveMirror }) {
  return mirror.kind === "session" ? (
    <SessionItem mirror={mirror} />
  ) : (
    <LiveItem
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
      <LiveItem
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
  const url = `http://localhost:${forward.localPort}`;
  return (
    <>
      <LiveItem
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
              onClick={onStop}
            >
              {stopping ? <Loader2 className="animate-spin" /> : <X />}
              {stopping ? "Stopping…" : "Stop"}
            </Button>
          </>
        }
        // Where it comes from, when the card does not already say:
        // another port than the local one, or no worktree.
        detail={
          showDevice || forward.remotePort !== forward.localPort ? (
            <>
              <span className="shrink-0">
                from <span className="font-mono">{forward.remotePort}</span>
              </span>
              {showDevice && (
                <>
                  <span className="shrink-0">on</span>
                  <DeviceName deviceId={forward.deviceId} />
                </>
              )}
            </>
          ) : undefined
        }
      />
      {open && worktree && (
        <PortsDialog worktree={worktree} onClose={() => setOpen(false)} />
      )}
    </>
  );
}
