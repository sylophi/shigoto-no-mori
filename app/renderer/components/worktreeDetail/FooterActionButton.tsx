// The worktree footer's leading verbs share one shape: a ghost text
// button that opens a dialog or a page. Files leads on every worktree,
// then Mirror (or, mirrored, the running mirror's Mirroring in its
// place). Each gives up its label on a narrow footer at its own rank
// (footerFit.tsx).
import type { ReactNode } from "react";
import { FooterVerb } from "./footerFit";

export function FooterActionButton({
  rank,
  icon,
  label,
  tip,
  disabledReason,
  onClick,
}: {
  rank: number;
  icon: ReactNode;
  label: string;
  tip?: string;
  // Disables the button and becomes its tip.
  disabledReason?: string;
  onClick: () => void;
}) {
  return (
    <FooterVerb
      rank={rank}
      icon={icon}
      label={label}
      type="button"
      variant="ghost"
      className="shrink-0 text-muted-foreground hover:text-foreground"
      tip={disabledReason ?? tip}
      disabled={disabledReason !== undefined}
      onClick={onClick}
    />
  );
}
