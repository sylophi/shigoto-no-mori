import { Rocket, Terminal, Trash2 } from "lucide-react";
import type { ScriptActivityKind } from "@/store/scriptRuns";

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
};

interface ActivityIconProps {
  kind: ScriptActivityKind;
}

export function ActivityIcon({ kind }: ActivityIconProps) {
  const { Icon, label, tone } = ACTIVITY[kind];
  return (
    <Icon
      aria-label={label}
      className={`size-3 shrink-0 animate-pulse ${tone}`}
    />
  );
}
