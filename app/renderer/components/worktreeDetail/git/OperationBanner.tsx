// The operation the worktree is stopped in (OperationBannerView), with
// its abort and continue.
import { useCommandAccess } from "@/hooks/remote/useCommandAccess";
import {
  useAbortOperation,
  useContinueOperation,
  useWorktreeOperation,
} from "@/hooks/worktrees/useGitHistory";
import { useWorktreeNav } from "@/hooks/worktrees/useWorktreeNav";
import type { Worktree } from "@shigomori/contracts/schemas";
import { OperationBannerView } from "./OperationBannerView";

export function OperationBanner({
  worktree,
  onGitPage,
}: {
  worktree: Worktree;
  onGitPage?: boolean;
}) {
  const nav = useWorktreeNav();
  const { data: state } = useWorktreeOperation(worktree);
  const proceed = useContinueOperation();
  const abort = useAbortOperation();
  const { canCommand } = useCommandAccess();
  const scope = { projectId: worktree.projectId, worktreeId: worktree.id };
  return (
    <OperationBannerView
      state={state}
      onGitPage={onGitPage}
      canCommand={canCommand}
      busy={proceed.isPending || abort.isPending}
      onAbort={() => abort.mutate(scope)}
      onContinue={() => proceed.mutate(scope)}
      onResolve={() => nav.toDiff(worktree.projectId, worktree.id)}
    />
  );
}
