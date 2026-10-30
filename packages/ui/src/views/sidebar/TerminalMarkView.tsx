import { SquareTerminal } from "lucide-react";
import { cn } from "../../lib/utils.ts";
import { TONE_MARK } from "../../primitives/status-dot.tsx";
import { SimpleTooltip } from "../../primitives/tooltip.tsx";

// A worktree's shells: one open, or one a command holds (a dev server,
// a build), which pulses as a running script does.
export type TerminalMark = "open" | "busy";

export function TerminalMarkView({ mark }: { mark: TerminalMark }) {
  const busy = mark === "busy";
  const label = busy ? "Running in a terminal" : "Terminal open";
  return (
    <SimpleTooltip tip={label}>
      <SquareTerminal
        aria-label={label}
        className={cn(
          "size-3 shrink-0",
          busy && "animate-pulse",
          busy ? TONE_MARK.sky : TONE_MARK.slate,
        )}
      />
    </SimpleTooltip>
  );
}
