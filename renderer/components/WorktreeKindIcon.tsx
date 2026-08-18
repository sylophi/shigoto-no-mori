import { Archive, FolderTree, House } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { Worktree } from "@shared/schemas";

const KINDS = {
  primary: { Icon: House, label: "Primary checkout" },
  external: { Icon: FolderTree, label: "External worktree" },
  shelved: { Icon: Archive, label: "Shelved" },
} as const;

// Exported so callers that need a fallback glyph for the plain case (the
// command palette draws a branch icon there) can ask without re-deriving
// the precedence order.
export function worktreeKind(worktree: Worktree): keyof typeof KINDS | null {
  if (worktree.isPrimary) return "primary";
  if (worktree.isExternal) return "external";
  if (worktree.shelved) return "shelved";
  return null;
}

export function WorktreeKindIcon({
  worktree,
  showTooltip = true,
}: {
  worktree: Worktree;
  showTooltip?: boolean;
}) {
  const kind = worktreeKind(worktree);
  if (!kind) return null;
  const { Icon, label } = KINDS[kind];
  const icon = (
    <span className="inline-flex shrink-0">
      <Icon aria-label={label} className="size-3 text-muted-foreground/70" />
    </span>
  );
  if (!showTooltip) return icon;
  return (
    <Tooltip>
      <TooltipTrigger render={icon} />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
