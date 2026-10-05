// The Live page's mirrors: every session any device runs, worded the
// way the worktree header words it (describeMirror), from the original
// to its copy. The controls stay behind the worktree's Mirror button,
// one click away through the row's link.
import { ArrowRight } from "lucide-react";
import { StatusDot, TONE_TEXT } from "@/components/ui/status-dot";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { describeMirror } from "@/components/worktreeDetail/mirror/mirrorStatus";
import type { LiveMirror } from "@/hooks/live/useLiveActivity";
import {
  useDeviceProperName,
  useRemoteDeviceApi,
} from "@/hooks/remote/useRemoteDevices";
import { useNow } from "@/hooks/ui/useNow";
import { localDeviceId } from "@/lib/queryKeys";
import { formatRelativeTime } from "@/lib/relativeTime";
import { cn } from "@/lib/utils";
import { DeviceRef, LiveRow, Sep, WorktreeRef } from "./LiveRow";

export function MirrorRow({
  mirror,
  showDevice,
}: {
  mirror: LiveMirror;
  showDevice: boolean;
}) {
  return mirror.kind === "session" ? (
    <SessionRow mirror={mirror} showDevice={showDevice} />
  ) : (
    <ServedRow mirror={mirror} />
  );
}

function Since({ at }: { at: number }) {
  const now = useNow();
  return (
    <SimpleTooltip tip={new Date(at).toLocaleString()}>
      <span className="tabular shrink-0">
        since {formatRelativeTime(at, now)}
      </span>
    </SimpleTooltip>
  );
}

function SessionRow({
  mirror,
  showDevice,
}: {
  mirror: Extract<LiveMirror, { kind: "session" }>;
  showDevice: boolean;
}) {
  const { session } = mirror;
  const runner = useDeviceProperName(mirror.runnerDeviceId);
  const view = describeMirror(session, {
    runnerAway: mirror.runnerApi === undefined ? runner : undefined,
    engine: mirror.engine,
  });
  return (
    <LiveRow
      lead={<StatusDot tone={view.tone} />}
      title={
        <WorktreeRef
          deviceId={mirror.runnerDeviceId}
          api={mirror.runnerApi}
          projectId={session.localProjectId}
          worktreeId={session.localWorktreeId}
        />
      }
      detail={
        <>
          <SimpleTooltip tip={view.detail || undefined}>
            <span className={cn("shrink-0", TONE_TEXT[view.tone])}>
              {view.label}
            </span>
          </SimpleTooltip>
          <Sep />
          {showDevice ? (
            <span className="inline-flex min-w-0 items-center gap-1">
              <DeviceRef deviceId={mirror.runnerDeviceId} />
              <ArrowRight
                aria-label="to"
                className="size-3 shrink-0 text-muted-foreground/60"
              />
              <DeviceRef deviceId={session.deviceId} />
            </span>
          ) : (
            <span className="inline-flex min-w-0 items-center gap-1">
              to <DeviceRef deviceId={session.deviceId} />
            </span>
          )}
          <Sep />
          <Since at={session.createdAt} />
        </>
      }
    />
  );
}

// A stream a device serves while the list of the device running the
// session is not in hand: the copy, and who keeps it in step.
function ServedRow({
  mirror,
}: {
  mirror: Extract<LiveMirror, { kind: "served" }>;
}) {
  const { stream, copyDeviceId } = mirror;
  const local = copyDeviceId === localDeviceId;
  const peerApi = useRemoteDeviceApi(local ? undefined : copyDeviceId);
  return (
    <LiveRow
      lead={<StatusDot tone="emerald" />}
      title={
        <WorktreeRef
          deviceId={copyDeviceId}
          api={local ? window.api : peerApi}
          projectId={stream.projectId}
          worktreeId={stream.worktreeId}
        />
      }
      detail={
        <>
          <span className={cn("shrink-0", TONE_TEXT.emerald)}>Mirrored</span>
          <Sep />
          <span className="inline-flex min-w-0 items-center gap-1">
            from <DeviceRef deviceId={stream.peerDeviceId} />
          </span>
          <Sep />
          <Since at={stream.since} />
        </>
      }
    />
  );
}
