// The worktree header's mirror line, drawn: one status chip per mirror
// the worktree is part of, each naming the other device. MirrorPill.tsx
// binds it to the worktree's mirrors.
// Built on the shared chip (primitives/chip-button.tsx) and the status tones
// (primitives/status-dot.tsx): emerald for a live mirror, sky while files or
// git state move (mirror/mirrorStatus.ts), amber for conflicts and
// reconnects, rose for a halt or an error, slate for paused.
import { RefreshCw } from "lucide-react";
import type { ComponentType, ReactNode, SVGProps } from "react";
import { Chip } from "../../primitives/chip-button.tsx";
import { type StatusTone, TONE_TEXT } from "../../primitives/status-dot.tsx";
import { SimpleTooltip } from "../../primitives/tooltip.tsx";
import { cn } from "../../lib/utils.ts";

type IconType = ComponentType<SVGProps<SVGSVGElement>>;

// A read-only status chip in one of the status tones.
export function MirrorStatusChipView({
  tone,
  icon: Icon = RefreshCw,
  label,
  tip,
  spinning = false,
}: {
  tone: StatusTone;
  icon?: IconType;
  label: string;
  tip?: string;
  spinning?: boolean;
}) {
  return (
    <SimpleTooltip tip={tip}>
      <Chip className={cn("tabular shrink-0", TONE_TEXT[tone])}>
        <Icon
          aria-hidden
          className={cn("size-3.5", spinning && "animate-spin")}
        />
        {label}
      </Chip>
    </SimpleTooltip>
  );
}

export function MirrorPillView({ lines }: { lines: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-1 text-xs">{lines}</div>
  );
}

// One mirror: its chip, and the device on the other side.
export function MirrorLineView({
  chip,
  other,
}: {
  chip: ReactNode;
  other: string;
}) {
  return (
    <>
      {chip}
      <span className="text-muted-foreground">with {other}</span>
    </>
  );
}
