// The Live page's scripts: every script a host runs right now, whoever
// started it (a worktree's launch row, a lifecycle the CLI ran, another
// device). A run's output streams only to the window that started it,
// so the console is offered where this window holds the run, and the
// worktree's page everywhere else. Stopping works on any run the device
// lets this one command.
import { useMutation } from "@tanstack/react-query";
import { Square, SquareTerminal } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import type { RunningScript } from "@shared/schemas";
import { Button } from "@/components/ui/button";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { commandAccessOf } from "@/hooks/remote/useCommandAccess";
import type { HostApi } from "@/hooks/remote/useHostScope";
import { useRemoteDevice } from "@/hooks/remote/useRemoteDevices";
import { useDeviceScriptRunState } from "@/hooks/scripts/useScriptRuns";
import { useNow } from "@/hooks/ui/useNow";
import { formatRelativeTime } from "@/lib/relativeTime";
import { WORKTREE_ROUTE_PATHS } from "@/lib/routePaths";
import { cn } from "@/lib/utils";
import {
  scriptKey,
  scriptRunsFor,
  slotLabel,
  slotToParam,
} from "@/store/scriptRuns";
import { DeviceRef, LiveRow, Sep, WorktreeRef } from "./LiveRow";

export function ScriptRow({
  deviceId,
  api,
  run,
  showDevice,
}: {
  deviceId: string;
  api: HostApi;
  run: RunningScript;
  showDevice: boolean;
}) {
  const now = useNow();
  const navigate = useNavigate();
  const key = scriptKey(run.projectId, run.worktreeId, run.slot);
  const state = useDeviceScriptRunState(deviceId, key);
  // This window started the run (or saw the CLI start it), so its
  // console has the output.
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
    <LiveRow
      lead={
        <span
          aria-hidden
          className="size-1.5 animate-pulse rounded-full bg-emerald-500"
        />
      }
      title={
        <span
          className={cn(
            "truncate font-medium",
            run.slot.kind === "package" && "font-mono",
          )}
        >
          {label}
        </span>
      }
      detail={
        <>
          <WorktreeRef
            deviceId={deviceId}
            api={api}
            projectId={run.projectId}
            worktreeId={run.worktreeId}
          />
          {showDevice && (
            <>
              <Sep />
              <DeviceRef deviceId={deviceId} />
            </>
          )}
          <Sep />
          <SimpleTooltip tip={new Date(run.startedAt).toLocaleString()}>
            <span className="tabular shrink-0">
              started {formatRelativeTime(run.startedAt, now)}
            </span>
          </SimpleTooltip>
        </>
      }
      actions={
        <>
          {held && (
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
              <SquareTerminal />
              Console
            </Button>
          )}
          {access.canCommand && (
            <Button
              size="xs"
              variant="outline-destructive"
              aria-label={`Stop ${label}`}
              disabled={stopping}
              onClick={() => cancel.mutate()}
            >
              <Square />
              {stopping ? "Stopping…" : "Stop"}
            </Button>
          )}
        </>
      }
    />
  );
}
