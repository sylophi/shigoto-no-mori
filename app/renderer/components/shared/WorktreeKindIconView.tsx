import { Archive, FolderTree, Hammer, House } from "lucide-react";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { isAgentWorking, type Worktree } from "@shigomori/contracts/schemas";

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

// The mark for a worktree of a kind worth naming. `allowAgentWorking`
// is the sidebar marks' setting (useAllowAgentWorking).
export function WorktreeKindIconView({
  worktree,
  allowAgentWorking,
}: {
  worktree: Worktree;
  allowAgentWorking: boolean;
}) {
  const kind = kindOf(worktree, allowAgentWorking);
  if (!kind) return null;
  const { Icon, label } = KINDS[kind];
  return (
    <SimpleTooltip tip={label}>
      <span className="inline-flex shrink-0">
        <Icon aria-label={label} className="size-3 text-muted-foreground/70" />
      </span>
    </SimpleTooltip>
  );
}
