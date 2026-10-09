import { WorktreeKindIconView } from "@/components/shared/WorktreeKindIconView";
import type { Worktree } from "@shigomori/contracts/schemas";
import { useAllowAgentWorking } from "@/hooks/config/useSidebarMarks";

export function WorktreeKindIcon({ worktree }: { worktree: Worktree }) {
  return (
    <WorktreeKindIconView
      worktree={worktree}
      allowAgentWorking={useAllowAgentWorking()}
    />
  );
}
