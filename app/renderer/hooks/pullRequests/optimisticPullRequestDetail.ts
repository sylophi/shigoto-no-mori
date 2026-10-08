import type { QueryClient } from "@tanstack/react-query";
import type { PullRequestDetail } from "@shigomori/contracts/schemas";
import type { QueryKeyRegistry } from "@/lib/queryKeys";

// The variables every PR action carries. The branch isn't on the wire
// (gh identifies the PR by number). It names the cache entry to patch.
interface PullRequestActionVariables {
  projectId: string;
  branch: string;
}

interface Context {
  key: ReturnType<QueryKeyRegistry["worktreePullRequest"]>;
  prev: PullRequestDetail | null | undefined;
}

// The optimistic write a PR action shares (draft toggle, auto-merge
// off): cancel in-flight refetches so they can't clobber it, snapshot
// the cached detail, write the patched one, and put the snapshot back
// on error. Returned as the mutation options the caller spreads.
export function optimisticPullRequestDetail<
  V extends PullRequestActionVariables,
>(
  qc: QueryClient,
  keys: QueryKeyRegistry,
  patch: (prev: PullRequestDetail, vars: V) => PullRequestDetail,
) {
  return {
    onMutate: async (vars: V): Promise<Context> => {
      const key = keys.worktreePullRequest(vars.projectId, vars.branch);
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<PullRequestDetail | null>(key);
      if (prev) {
        qc.setQueryData<PullRequestDetail | null>(key, patch(prev, vars));
      }
      return { key, prev };
    },
    onError: (_err: Error, _vars: V, context: Context | undefined) => {
      if (!context) return;
      qc.setQueryData(context.key, context.prev);
    },
  };
}
