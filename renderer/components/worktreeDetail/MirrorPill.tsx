// The worktree header's mirror line: what this worktree's live mirror
// is doing, if it has one. One line per mirror the worktree is part
// of, on either side of it (hooks/remote/useMirrors.ts
// useWorktreeMirrorLinks): status, conflicts and problems, and the
// other device by name. A peer's mirror whose session is not in hand
// yet is named alone. Quiet when there is nothing to say. The details
// and the controls live in the dialog behind the footer's Mirror
// button (mirror/MirrorAction.tsx), which drives the session through
// the device running it.
// Built on the shared chip (ui/chip-button.tsx) and the status tones
// (ui/status-dot.tsx): emerald for a settled live mirror, sky while
// cycles run, amber for conflicts and reconnects, rose for a halt or
// an error, slate for paused.
import { RefreshCw } from "lucide-react";
import type { ComponentType, SVGProps } from "react";
import type { Worktree } from "@shared/schemas";
import { Chip } from "@/components/ui/chip-button";
import { type StatusTone, TONE_TEXT } from "@/components/ui/status-dot";
import { MirrorConflictsChip } from "@/components/worktreeDetail/MirrorConflicts";
import { describeMirror } from "@/components/worktreeDetail/mirror/mirrorStatus";
import {
  useWorktreeMirrorLinks,
  type WorktreeMirrorLink,
} from "@/hooks/remote/useMirrors";
import { useDeviceName } from "@/hooks/remote/useRemoteDevices";
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

export function MirrorPill({ worktree }: { worktree: Worktree }) {
  const links = useWorktreeMirrorLinks(worktree);
  if (links.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1 text-xs">
      {links.map((link) => (
        <SessionLine key={link.runnerDeviceId} link={link} />
      ))}
    </div>
  );
}

function SessionLine({ link }: { link: WorktreeMirrorLink }) {
  const other = useDeviceName(link.otherDeviceId);
  const { session } = link;
  if (session === undefined) {
    return (
      <>
        <StatusChip
          tone="emerald"
          icon={RefreshCw}
          label="Mirrored"
          title="A peer keeps a live copy of this worktree"
        />
        <span className="text-muted-foreground">to {other}</span>
      </>
    );
  }
  const view = describeMirror(session);
  return (
    <>
      {view.showConflicts ? (
        <MirrorConflictsChip
          session={session}
          tone={view.tone}
          label={view.label}
          // Revealing is this machine's Finder, under the runner's
          // copy.
          canReveal={link.runnerDeviceId === localDeviceId}
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
      <span className="text-muted-foreground">with {other}</span>
    </>
  );
}
