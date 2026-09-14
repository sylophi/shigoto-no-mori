// The worktree header's mirror line: what this worktree's live mirror
// is doing, if it has one. Two shapes, both quiet when there is
// nothing to say:
//   - this worktree is the LOCAL copy of a peer's worktree (a session
//     this device runs): status, conflicts and problems. The details
//     and the controls live in the dialog behind the footer's Mirror
//     button (mirror/MirrorManageDialog.tsx).
//   - this worktree is being mirrored BY peers (streams this device
//     serves): one chip naming them.
// Built on the shared chip (ui/chip-button.tsx) and the status tones
// (ui/status-dot.tsx): emerald for a settled live mirror, sky while
// cycles run, amber for conflicts and reconnects, rose for a halt or
// an error, slate for paused.
import { RefreshCw } from "lucide-react";
import type { ComponentType, SVGProps } from "react";
import type { MirrorSession } from "@shared/ipc/modules/mirror";
import type { Worktree } from "@shared/schemas";
import { Chip } from "@/components/ui/chip-button";
import { type StatusTone, TONE_TEXT } from "@/components/ui/status-dot";
import { MirrorConflictsChip } from "@/components/worktreeDetail/MirrorConflicts";
import { describeMirror } from "@/components/worktreeDetail/mirror/mirrorStatus";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { useWorktreeMirror } from "@/hooks/remote/useMirrors";
import { useRemoteDeviceLabel } from "@/hooks/remote/useRemoteDevices";
import { localDeviceId } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";

type IconType = ComponentType<SVGProps<SVGSVGElement>>;

// A read-only status chip in one of the status tones.
function StatusChip({
  tone,
  icon: Icon,
  label,
  title,
  spinning = false,
}: {
  tone: StatusTone;
  icon: IconType;
  label: string;
  title: string;
  spinning?: boolean;
}) {
  return (
    <Chip className={cn("tabular shrink-0", TONE_TEXT[tone])} title={title}>
      <Icon
        aria-hidden
        className={cn("size-3.5", spinning && "animate-spin")}
      />
      {label}
    </Chip>
  );
}

// The other party by name: a peer's label, or "this device" when the
// worktree being viewed is served TO the machine showing it (a remote
// worktree page on the device that mirrors it).
function PeerName({ deviceId }: { deviceId: string }) {
  const label = useRemoteDeviceLabel(deviceId);
  if (deviceId === localDeviceId) return <>this device</>;
  return <>{label || "another device"}</>;
}

export function MirrorPill({ worktree }: { worktree: Worktree }) {
  const { remote } = useHostScope();
  const { session, serving } = useWorktreeMirror(worktree);
  if (session === undefined && serving.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1 text-xs">
      {session !== undefined && (
        <SessionLine session={session} canControl={!remote} />
      )}
      {serving.length > 0 && (
        <>
          <StatusChip
            tone="emerald"
            icon={RefreshCw}
            label="Mirrored"
            title="A peer keeps a live copy of this worktree"
          />
          <span className="text-muted-foreground">
            to{" "}
            {serving.map((stream, index) => (
              <span key={stream.channelId}>
                {index > 0 && ", "}
                <PeerName deviceId={stream.peerDeviceId} />
              </span>
            ))}
          </span>
        </>
      )}
    </div>
  );
}

function SessionLine({
  session,
  canControl,
}: {
  session: MirrorSession;
  canControl: boolean;
}) {
  const view = describeMirror(session);
  return (
    <>
      {view.showConflicts ? (
        <MirrorConflictsChip
          session={session}
          tone={view.tone}
          label={view.label}
          canReveal={canControl}
        />
      ) : (
        <StatusChip
          tone={view.tone}
          icon={RefreshCw}
          label={view.label}
          title={view.detail || view.label}
          spinning={view.spinning}
        />
      )}
      <span className="text-muted-foreground">
        with <PeerName deviceId={session.deviceId} />
      </span>
    </>
  );
}
