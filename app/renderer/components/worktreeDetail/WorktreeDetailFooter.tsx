import { type ReactNode, useRef } from "react";
import {
  useSetAutoPull,
  useSetShelved,
} from "@/hooks/worktrees/useWorktreeMutations";
import type { Worktree } from "@shared/schemas";
import { useFittedLabels } from "./footerFit";
import {
  type WorktreeFooterActions,
  type WorktreeFooterState,
  WorktreeDetailFooterView,
} from "./WorktreeDetailFooterView";

export type {
  WorktreeFooterActions,
  WorktreeFooterState,
} from "./WorktreeDetailFooterView";

// The worktree page's footer (WorktreeDetailFooterView), with the quiet
// state's toggles and its labels fitted to the pane.
interface WorktreeDetailFooterProps {
  worktree: Worktree;
  state: WorktreeFooterState;
  actions: WorktreeFooterActions;
  // The scope's own verbs (ports, mirror, transplant), rendered as a
  // leading row in the quiet state only: the deletion state machine
  // keeps the whole footer once it engages.
  leading?: ReactNode;
  // False when a remote host has not granted this client command
  // access: the mutating affordances (shelve, delete) stay off, the
  // rest of the page is the read-only mirror.
  canMutate?: boolean;
}

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
