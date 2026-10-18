// A peer's port list's bulk actions: forward every listed port in one
// go, and stop every forward the list shows (ForwardAllButton runs
// them).
import type { ReactNode } from "react";
import { Loader2, Power, PowerOff } from "lucide-react";
import { Button } from "../../../primitives/button.tsx";
import { SimpleTooltip } from "../../../primitives/tooltip.tsx";

export type ForwardAllMode = "start" | "stop";

const MODE_FACE: Record<ForwardAllMode, { icon: ReactNode; label: string }> = {
  start: { icon: <Power />, label: "Forward all" },
  stop: { icon: <PowerOff />, label: "Stop all" },
};

// The buttons (ForwardAllButton runs them): Forward all while a listed
// port isn't forwarded, Stop all while one is.
export function ForwardAllButtonView({
  modes,
  runningMode,
  canStart,
  startBlocker,
  waiting,
  onRun,
}: {
  modes: readonly ForwardAllMode[];
  // The bulk action under way.
  runningMode: ForwardAllMode | null;
  canStart: boolean;
  // Why nothing can start, when nothing can.
  startBlocker: string | undefined;
  // The local ports each start lands on are still being read.
  waiting: boolean;
  onRun: (mode: ForwardAllMode) => void;
}) {
  return (
    <>
      {modes.map((mode) => {
        const running = runningMode === mode;
        const face = running
          ? {
              icon: <Loader2 className="animate-spin" />,
              label: mode === "start" ? "Forwarding…" : "Stopping…",
            }
          : MODE_FACE[mode];
        return (
          <SimpleTooltip
            key={mode}
            tip={
              mode === "start" && runningMode === null
                ? startBlocker
                : undefined
            }
          >
            <Button
              variant="ghost"
              size="sm"
              disabled={
                runningMode !== null ||
                waiting ||
                (mode === "start" && !canStart)
              }
              onClick={() => onRun(mode)}
            >
              {face.icon}
              {face.label}
            </Button>
          </SimpleTooltip>
        );
      })}
    </>
  );
}
