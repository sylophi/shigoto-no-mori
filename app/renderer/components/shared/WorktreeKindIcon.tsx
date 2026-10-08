import { Archive, FolderTree, Hammer, House } from "lucide-react";
import { useAllowAgentWorking } from "@/hooks/config/useSidebarMarks";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { isAgentWorking, type Worktree } from "@shared/schemas";

const KINDS = {
  primary: { Icon: House, label: "Primary checkout" },
  external: { Icon: FolderTree, label: "External worktree" },
  agentWorking: { Icon: Hammer, label: "Agent working" },
  shelved: { Icon: Archive, label: "Shelved" },
} as const;

function kindOf(
  worktree: Worktree,
  allowAgentWorking: boolean,
): keyof typeof KINDS | null {
  if (worktree.isPrimary) return "primary";
  if (worktree.isExternal) return "external";
  if (isAgentWorking(worktree, allowAgentWorking)) return "agentWorking";
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
  const kind = kindOf(worktree, useAllowAgentWorking());
  if (!kind) return null;
  const { Icon, label } = KINDS[kind];
  return (
    <SimpleTooltip tip={showTooltip && label}>
      <span className="inline-flex shrink-0">
        <Icon aria-label={label} className="size-3 text-muted-foreground/70" />
      </span>
    </SimpleTooltip>
  );
}
