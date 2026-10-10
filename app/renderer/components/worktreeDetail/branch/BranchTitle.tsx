// The branch's title (BranchTitleView), renamed in place, with its menu
// and the switcher behind it.
import { useRef, useState } from "react";
import { useCommandAccess } from "@/hooks/remote/useCommandAccess";
import { useRenameBranch } from "@/hooks/worktrees/useWorktreeBranchOps";
import type { Worktree } from "@shigomori/contracts/schemas";
import { BranchSwitcher } from "./BranchSwitcher";
import {
  BranchMenuView,
  BranchTitleView,
} from "@shigomori/ui/views/worktreeDetail/branch/BranchTitleView.tsx";

export function BranchTitle({
  worktree,
  subtitle = false,
}: {
  worktree: Worktree;
  subtitle?: boolean;
}) {
  // null while idle; the in-flight edit value otherwise. Folds "editing"
  // and "draft" together so we don't seed state from a prop.
  const [draft, setDraft] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  const rename = useRenameBranch();
  const { canCommand } = useCommandAccess();
  const titleRef = useRef<HTMLHeadingElement>(null);

  const begin = () => {
    if (worktree.detached) return;
    rename.reset();
    setDraft(worktree.branch);
  };
  const cancel = () => {
    setDraft(null);
    rename.reset();
  };
  const commit = () => {
    const next = (draft ?? "").trim();
    if (!next || next === worktree.branch) {
      cancel();
      return;
    }
    rename.mutate(
      {
        projectId: worktree.projectId,
        worktreeId: worktree.id,
        newBranch: next,
      },
      { onSuccess: () => setDraft(null) },
    );
  };

  return (
    <BranchTitleView
      branch={worktree.branch}
      detached={worktree.detached}
      subtitle={subtitle}
      titleRef={titleRef}
      editing={
        draft === null
          ? undefined
          : {
              draft,
              onDraftChange: setDraft,
              pending: rename.isPending,
              error: rename.error?.message,
              onCommit: commit,
              onCancel: cancel,
            }
      }
      menu={
        <BranchMenuView
          canCommand={canCommand}
          detached={worktree.detached}
          onRename={begin}
          onSwitch={() => setSwitching(true)}
          onCopy={() => void navigator.clipboard.writeText(worktree.branch)}
          switcher={
            <BranchSwitcher
              worktree={worktree}
              anchorRef={titleRef}
              open={switching}
              onOpenChange={setSwitching}
            />
          }
        />
      }
    />
  );
}
