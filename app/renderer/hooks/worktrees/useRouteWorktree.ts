// What every worktree sub-page (the diffs, the script console) does
// first: read the route's params, resolve its worktree out of the list
// query, and know the way back. `worktree` is undefined while the list
// is pending, when it failed, and when the target is gone (or was
// deleted while the page was open). `missing` carries what
// WorktreeMissing needs to tell those apart, so a page's guard is one
// line.
import { useWorktreeWasDeleted } from "@/hooks/worktrees/useWorktreeWasDeleted";
import { useWorktrees } from "@/hooks/worktrees/useWorktrees";
import {
  useScopedWorktreeParams,
  useWorktreeNav,
} from "@/hooks/worktrees/useWorktreeNav";

export function useRouteWorktree() {
  const params = useScopedWorktreeParams();
  const nav = useWorktreeNav();
  const {
    data: worktrees = [],
    isPending,
    isError,
    refetch,
  } = useWorktrees(params.projectId);
  const worktree = worktrees.find((w) => w.id === params.worktreeId);
  const deleted = useWorktreeWasDeleted(params.worktreeId, worktree);
  const goBack = () => nav.toWorktree(params.projectId, params.worktreeId);
  return {
    ...params,
    nav,
    worktree,
    goBack,
    missing: { isPending, isError, deleted, refetch, onBack: goBack },
  };
}
