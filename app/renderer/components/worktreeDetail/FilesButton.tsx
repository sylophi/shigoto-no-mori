// The footer's Files button, first of the footer's verbs on the local
// and the remote worktree page alike: the way into the files page.
// Reading a peer's files rides its command grant (worktrees:readFile),
// so a read-only peer's footer leaves it out rather than offer a page
// that could only say no.
import { FolderSearch } from "lucide-react";
import { useCommandAccess } from "@/hooks/remote/useCommandAccess";
import { useWorktreeNav } from "@/hooks/worktrees/useWorktreeNav";
import type { Worktree } from "@shared/schemas";
import { FooterActionButton } from "./FooterActionButton";

export function FilesButton({ worktree }: { worktree: Worktree }) {
  const { toFiles } = useWorktreeNav();
  const { canCommand } = useCommandAccess();
  if (!canCommand) return null;
  return (
    <FooterActionButton
      icon={<FolderSearch />}
      label="Files"
      title="Browse this worktree's files"
      onClick={() => toFiles(worktree.projectId, worktree.id)}
    />
  );
}
