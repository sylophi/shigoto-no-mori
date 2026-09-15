// The worktree footer's leading verbs share one shape: a ghost text
// button that opens a dialog. Ports, Mirror here and Transplant here on
// a peer's worktree, Ports and the running mirror on this device's own.
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";

export function FooterActionButton({
  icon,
  label,
  title,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  title?: string;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      size="xs"
      variant="ghost"
      className="shrink-0 text-muted-foreground hover:text-foreground"
      title={title}
      onClick={onClick}
    >
      {icon}
      {label}
    </Button>
  );
}
