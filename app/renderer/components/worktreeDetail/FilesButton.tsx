// The footer's Files button, first of the footer's verbs on the local
// and the remote worktree page alike: the way into the files page.
// Reading a peer's files rides its command grant (worktrees:readFile),
// so a read-only peer's footer leaves it out rather than offer a page
// that could only say no.
import { FolderSearch } from "lucide-react";
import { useCommandAccess } from "@/hooks/remote/useCommandAccess";
import { useWorktreeNav } from "@/hooks/worktrees/useWorktreeNav";
import type { Worktree } from "@shigomori/contracts/schemas";
import { FooterActionButtonView } from "@shigomori/ui/views/worktreeDetail/FooterActionButtonView.tsx";
import { LABEL_RANK } from "@shigomori/ui/views/worktreeDetail/FooterVerbView.tsx";

export function FilesButton({ worktree }: { worktree: Worktree }) {
  const { toFiles } = useWorktreeNav();
  const { canCommand } = useCommandAccess();
  if (!canCommand) return null;
  return (
    <FooterActionButtonView
      rank={LABEL_RANK.files}
      icon={<FolderSearch />}
      label="Files"
      onClick={() => toFiles(worktree.projectId, worktree.id)}
    />
  );
}
