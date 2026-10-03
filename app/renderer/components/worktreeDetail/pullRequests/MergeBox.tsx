import type { PullRequestStack } from "@shared/pullRequestStack";
import type {
  MergeMethod,
  PullRequestDetail,
  RepoMergeConfig,
  Worktree,
} from "@shared/schemas";
import { MergeBoxView } from "./MergeBoxView";
import { useMergeBox } from "./useMergeBox";

// The merge box (MergeBoxView), with its mutations and picks.
export function MergeBox({
  worktree,
  pr,
  repoConfig,
  lastMergeMethod,
  stack,
}: {
  worktree: Worktree;
  pr: PullRequestDetail;
  repoConfig: RepoMergeConfig | null;
  lastMergeMethod: MergeMethod | undefined;
  stack: PullRequestStack | null;
}) {
  const {
    merge,
    setDraft,
    disableAutoMerge,
    armed,
    trigger,
    runMerge,
    pickMethod,
    pickReach,
    toggleDraft,
    runDisableAutoMerge,
    ...state
  } = useMergeBox({ worktree, pr, repoConfig, lastMergeMethod, stack });
  const { activeMethod } = state;

  return (
    <MergeBoxView
      pr={pr}
      state={state}
      armed={armed}
      mergePending={merge.isPending}
      setDraftPending={setDraft.isPending}
      disablePending={disableAutoMerge.isPending}
      mergeError={merge.error?.message}
      setDraftError={setDraft.error?.message}
      disableError={disableAutoMerge.error?.message}
      onMerge={() => {
        if (activeMethod) trigger(() => runMerge(activeMethod));
      }}
      onPickMethod={pickMethod}
      onPickReach={pickReach}
      onToggleDraft={toggleDraft}
      onDisableAutoMerge={runDisableAutoMerge}
    />
  );
}
