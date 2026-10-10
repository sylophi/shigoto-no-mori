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
} from "@shigomori/contracts/schemas/index";
import { cn } from "../../lib/utils.ts";
import { type StatusTone, TONE_PILL } from "../../primitives/status-dot.tsx";

const TONE: Record<HygieneVerdictKind, StatusTone> = {
  merged: "emerald",
  absorbed: "emerald",
  dirty: "amber",
  unpushed: "rose",
  active: "sky",
  unknown: "slate",
  defaultBranch: "slate",
};

const ICON: Record<HygieneVerdictKind, typeof Check> = {
  merged: Check,
  absorbed: Check,
  dirty: AlertTriangle,
  unpushed: Upload,
  active: GitBranch,
  unknown: CircleHelp,
  defaultBranch: Home,
};

export function TidyVerdictBadgeView({ kind }: { kind: HygieneVerdictKind }) {
  const Icon = ICON[kind];
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-3xs font-medium",
        TONE_PILL[TONE[kind]],
      )}
    >
      <Icon aria-hidden className="size-3" />
      {HYGIENE_VERDICT_LABEL[kind]}
    </span>
  );
}
