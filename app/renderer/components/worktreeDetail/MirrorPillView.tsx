// The worktree header's mirror line as drawn (MirrorPill.tsx works out
// what each mirror is doing): per mirror, a status chip and the other
// device. Quiet when there are no lines.
import { RefreshCw } from "lucide-react";
import {
  type ComponentType,
  Fragment,
  type ReactNode,
  type SVGProps,
} from "react";
import { Chip } from "@/components/ui/chip-button";
import { type StatusTone, TONE_TEXT } from "@/components/ui/status-dot";
import { cn } from "@/lib/utils";

type IconType = ComponentType<SVGProps<SVGSVGElement>>;

export interface MirrorStatusLook {
  tone: StatusTone;
  label: string;
  title: string;
  spinning?: boolean;
}

export interface MirrorPillLine {
  key: string;
  status: MirrorStatusLook;
  // The chip in the status's place when the mirror has conflicts to
  // show (MirrorConflictsChip, which reveals them).
  conflicts?: ReactNode;
  // "to Thinkpad" or "with Thinkpad".
  peer: string;
}

export function MirrorPillView({ lines }: { lines: MirrorPillLine[] }) {
  if (lines.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1 text-xs">
      {lines.map((line) => (
        <Fragment key={line.key}>
          {line.conflicts ?? (
            <StatusChip
              tone={line.status.tone}
              icon={RefreshCw}
              label={line.status.label}
              title={line.status.title}
              spinning={line.status.spinning}
            />
          )}
          <span className="text-muted-foreground">{line.peer}</span>
        </Fragment>
      ))}
    </div>
  );
}

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
