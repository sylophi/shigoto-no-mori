import {
  ALL_TICKED,
  type ChangesPicks,
} from "@shigomori/ui/views/diff/changesPicks.ts";
import {
  createWorktreeStore,
  useWorktreeStore,
  type WorktreeRef,
} from "./worktreeState";

// What the changes page has ticked (changesPicks), held for the session
// per worktree, so leaving the page and coming back keeps it. A reload
// starts over at everything.
const picks = createWorktreeStore<ChangesPicks>({
  empty: ALL_TICKED,
  moves: false,
});

export const useChangesPicks = (ref: WorktreeRef): ChangesPicks =>
  useWorktreeStore(picks, ref);

export const updatePicks = picks.update;
