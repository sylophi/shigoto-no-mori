import {
  AlertTriangle,
  Check,
  CircleHelp,
  GitBranch,
  Home,
  Upload,
} from "lucide-react";
import {
  HYGIENE_VERDICT_LABEL,
  type HygieneVerdictKind,
} from "@shared/schemas";
import { cn } from "@/lib/utils";

// Tone per verdict, spelled out as whole class strings because Tailwind
// can't see interpolated names. Stays inside the four raw palette
// families doubutsu.css remaps (emerald / rose / amber / sky); anything
// neutral uses theme tokens instead.
const TONE: Record<HygieneVerdictKind, string> = {
  merged: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  absorbed: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  dirty: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  unpushed: "bg-rose-500/10 text-rose-600 dark:text-rose-400",
  active: "bg-sky-500/10 text-sky-600 dark:text-sky-400",
  unknown: "bg-muted text-muted-foreground",
  defaultBranch: "bg-muted text-muted-foreground",
  primary: "bg-muted text-muted-foreground",
};

const ICON: Record<HygieneVerdictKind, typeof Check> = {
  merged: Check,
  absorbed: Check,
  dirty: AlertTriangle,
  unpushed: Upload,
  active: GitBranch,
  unknown: CircleHelp,
  defaultBranch: Home,
  primary: Home,
};

export function TidyVerdictBadge({ kind }: { kind: HygieneVerdictKind }) {
  const Icon = ICON[kind];
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium",
        TONE[kind],
      )}
    >
      <Icon aria-hidden className="size-3" />
      {HYGIENE_VERDICT_LABEL[kind]}
    </span>
  );
}
