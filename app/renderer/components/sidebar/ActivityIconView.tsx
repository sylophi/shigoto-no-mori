import { CircleAlert, Rocket, Terminal, Trash2 } from "lucide-react";
import type { ScriptActivityKind } from "@/store/scriptRuns";
import { cn } from "@shigomori/ui/lib/utils.ts";
import { SimpleTooltip } from "@shigomori/ui/primitives/tooltip.tsx";

const ACTIVITY: Record<
  ScriptActivityKind,
  { Icon: typeof Rocket; label: string; tone: string }
> = {
  setup: { Icon: Rocket, label: "Setup running", tone: "text-emerald-500" },
  teardown: {
    Icon: Trash2,
    label: "Teardown running",
    tone: "text-destructive",
  },
  package: { Icon: Terminal, label: "Script running", tone: "text-violet-500" },
  failed: {
    Icon: CircleAlert,
    label: "A script failed",
    tone: "text-rose-500",
  },
};

interface ActivityIconProps {
  kind: ScriptActivityKind;
}

export function ActivityIconView({ kind }: ActivityIconProps) {
  const { Icon, label, tone } = ACTIVITY[kind];
  // The failure is news, not progress, so it holds still.
  return (
    <SimpleTooltip tip={label}>
      <Icon
        aria-label={label}
        className={cn(
          "size-3 shrink-0",
          kind !== "failed" && "animate-pulse",
          tone,
        )}
      />
    </SimpleTooltip>
  );
}
