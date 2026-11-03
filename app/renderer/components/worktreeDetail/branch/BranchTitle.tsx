// The branch's title (BranchTitleView), renamed in place, with its
// buttons and the switcher beside it.
import { useRef, useState } from "react";
import { useCommandAccess } from "@/hooks/remote/useCommandAccess";
import { useRenameBranch } from "@/hooks/worktrees/useWorktreeBranchOps";
import type { Worktree } from "@shigomori/contracts/schemas";
import { BranchSwitcher } from "./BranchSwitcher";
import {
  BranchActionsView,
  BranchTitleView,
} from "@shigomori/ui/views/worktreeDetail/branch/BranchTitleView.tsx";

export function BranchTitle({
  worktree,
  subtitle = false,
}: {
  worktree: Worktree;
  subtitle?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [switching, setSwitching] = useState(false);
  const rename = useRenameBranch();
  const { canCommand } = useCommandAccess();
  const titleRef = useRef<HTMLHeadingElement>(null);

  // A detached head has no branch to rename, but can switch onto one.
  const canRename = canCommand && !worktree.detached;

  const begin = () => {
    rename.reset();
    setEditing(true);
  };
  const cancel = () => {
    setEditing(false);
    rename.reset();
  };
  const save = (newBranch: string) =>
    rename.mutate(
      { projectId: worktree.projectId, worktreeId: worktree.id, newBranch },
      { onSuccess: () => setEditing(false) },
    );

  return (
    <BranchTitleView
      branch={worktree.branch}
      detached={worktree.detached}
      rebasing={worktree.rebasing}
      subtitle={subtitle}
      titleRef={titleRef}
      editing={
        editing
          ? {
              pending: rename.isPending,
              error: rename.error?.message,
              onSave: save,
              onCancel: cancel,
            }
          : undefined
      }
      actions={
        <BranchActionsView
          branch={worktree.branch}
          detached={worktree.detached}
          onRename={canRename ? begin : undefined}
          onSwitch={canCommand ? () => setSwitching(true) : undefined}
          onCopy={() => void navigator.clipboard.writeText(worktree.branch)}
          switcher={
            canCommand && (
              <BranchSwitcher
                worktree={worktree}
                anchorRef={titleRef}
                open={switching}
                onOpenChange={setSwitching}
              />
            )
          }
        />
      }
    />
  );
}
