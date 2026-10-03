import { useRef } from "react";
import {
  useSetAutoPull,
  useSetShelved,
} from "@/hooks/worktrees/useWorktreeMutations";
import { useFittedLabels } from "./footerFit";
import {
  type WorktreeFooterActions,
  WorktreeDetailFooterView,
  type WorktreeDetailFooterViewProps,
} from "./WorktreeDetailFooterView";

// The worktree page's footer (WorktreeDetailFooterView), with the quiet
// state's toggles and its labels fitted to the pane.
type WorktreeDetailFooterProps = Pick<
  WorktreeDetailFooterViewProps,
  "worktree" | "state" | "leading" | "canMutate"
> & { actions: WorktreeFooterActions };

export function WorktreeDetailFooter({
  worktree,
  state,
  actions,
  leading,
  canMutate = true,
}: WorktreeDetailFooterProps) {
  // On a narrow pane the verbs give up their labels one at a time
  // rather than run into each other (footerFit.tsx).
  const footerRef = useRef<HTMLElement>(null);
  const leadingRef = useRef<HTMLDivElement>(null);
  const collapsedThrough = useFittedLabels(footerRef, leadingRef);
  const setShelved = useSetShelved();
  const setAutoPull = useSetAutoPull();
  return (
    <WorktreeDetailFooterView
      worktree={worktree}
      state={state}
      actions={actions}
      toggles={{
        autoPullPending: setAutoPull.isPending,
        shelvePending: setShelved.isPending,
        onToggleAutoPull: () =>
          setAutoPull.mutate({
            projectId: worktree.projectId,
            worktreeId: worktree.id,
            autoPull: !worktree.autoPull,
          }),
        onToggleShelved: () =>
          setShelved.mutate({
            projectId: worktree.projectId,
            worktreeId: worktree.id,
            shelved: !worktree.shelved,
          }),
      }}
      leading={leading}
      canMutate={canMutate}
      footerRef={footerRef}
      leadingRef={leadingRef}
      collapsedThrough={collapsedThrough}
    />
  );
}
