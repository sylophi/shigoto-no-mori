// The worktree footer's leading verbs share one shape: a ghost text
// button that opens a dialog or a page. Files leads on every worktree,
// then Ports, Mirror here and Transplant here on a peer's worktree,
// Ports and the running mirror on this device's own. Each gives up its
// label on a narrow footer at its own rank (footerFit.tsx).
import type { ReactNode } from "react";
import { FooterVerb } from "./footerFit";

export function FooterActionButton({
  rank,
  icon,
  label,
  title,
  disabledReason,
  onClick,
}: {
  rank: number;
  icon: ReactNode;
  label: string;
  title?: string;
  // Disables the button and becomes its title.
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
      title={disabledReason ?? title}
      disabled={disabledReason !== undefined}
      onClick={onClick}
    />
  );
}
