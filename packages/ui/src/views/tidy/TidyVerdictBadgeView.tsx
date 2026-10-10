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
import { ToneTag } from "../../primitives/row-tag.tsx";
import type { StatusTone } from "../../primitives/status-dot.tsx";

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
    <ToneTag tone={TONE[kind]}>
      <Icon aria-hidden className="size-3" />
      {HYGIENE_VERDICT_LABEL[kind]}
    </ToneTag>
  );
}
