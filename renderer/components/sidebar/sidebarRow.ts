import type { Project, PullRequest, Worktree } from "@shared/schemas";

// The two shelves the inbox view folds shut by default. The third box --
// the live one -- has no header and no toggle, so it isn't in this union.
export type InboxShelf = "shelved" | "merged";

export type SidebarRow =
  | { kind: "project"; key: string; project: Project; expanded: boolean }
  | { kind: "worktree"; key: string; worktree: Worktree }
  // The inbox's own row: taller, cross-project, and built to be triaged
  // rather than picked out of a short list. See InboxRow. The PR rides
  // along because the builder already had to look it up to decide which
  // box the row belongs in -- resolving it again per row would put a
  // query observer on every visible row for an answer already in hand.
  | {
      kind: "inbox-worktree";
      key: string;
      worktree: Worktree;
      projectName: string;
      pr: PullRequest | undefined;
    }
  | { kind: "worktree-skeleton"; key: string; projectId: string }
  | { kind: "worktree-error"; key: string; projectId: string }
  // A peer device's worktree, merged into the tree beside the local
  // rows: under the local project sharing its repo identity when one
  // exists, else under a remote-project header. groupId names the group
  // it renders in (the local project's id, or the remote group key) so
  // hover attribution works without re-deriving the merge.
  | {
      kind: "remote-worktree";
      key: string;
      worktree: Worktree;
      deviceId: string;
      deviceLabel: string;
      groupId: string;
    }
  // Header for remote worktrees whose project has no local counterpart.
  // Not a Project row: it carries no local actions, no collapse state,
  // and may span several devices sharing one repo identity. The icon
  // fields name one (device, project) to fetch the repo's icon from --
  // any member serves, it is the same repo.
  | {
      kind: "remote-project";
      key: string;
      name: string;
      count: number;
      groupId: string;
      iconDeviceId: string;
      iconProjectId: string;
    }
  | {
      kind: "shelved-toggle";
      key: string;
      projectId: string;
      count: number;
      expanded: boolean;
    }
  | {
      kind: "inbox-shelf";
      key: string;
      shelf: InboxShelf;
      count: number;
      expanded: boolean;
    };

// What a view hands the sidebar shell. Both row builders produce this,
// so the shell renders one of them without knowing which.
export interface SidebarViewModel {
  rows: SidebarRow[];
  failedCount: number;
  // Shown instead of the list when the view has nothing to render and
  // isn't merely still resolving. Null means "say nothing" -- which
  // includes the loading case, since a flash of "nothing here" while the
  // answer is still in flight is worse than a beat of blank space.
  emptyMessage: string | null;
  // Which row to scroll to when navigation lands on a worktree from
  // outside the sidebar. Falls back to whatever contains it when its own
  // row isn't rendered -- a folded project in the tree, a folded shelf in
  // the inbox -- and null when the view can't place it at all. Neither
  // view unfolds anything on the way: the empty-state redirect runs on
  // every launch, and auto-expanding would undo the user's folding.
  revealKey: (projectId: string, worktreeId: string) => string | null;
}

export const ROW_SIZE_HINTS: Record<SidebarRow["kind"], number> = {
  project: 28,
  worktree: 40,
  "worktree-skeleton": 36,
  "worktree-error": 24,
  "shelved-toggle": 24,
  "inbox-worktree": 66,
  "inbox-shelf": 36,
  "remote-worktree": 40,
  "remote-project": 28,
};

// Where the row sits in the scroller, read off the kind rather than
// handed down from the view, so the virtualizer never has to be told
// which layout it is drawing.
//
// The tree insets its child rows under a project header and packs them
// tight: they are one line each, and the indent already says where a
// group starts and stops. The inbox has neither, so its rows keep a gap
// under them. Three-line rows butted together read as one block of text
// with nothing for the eye to break on.
//
// Padding, not margin: the virtualizer sizes each row from offsetHeight,
// which counts the one and ignores the other, so a margin would let the
// next row overlap instead of parting them.
export const ROW_LAYOUT: Record<SidebarRow["kind"], string> = {
  project: "px-2",
  worktree: "px-2 pl-5",
  "worktree-skeleton": "px-2 pl-5",
  "worktree-error": "px-2 pl-5",
  "shelved-toggle": "px-2 pl-5",
  "inbox-worktree": "px-2 pb-1",
  "inbox-shelf": "px-2 pb-1",
  "remote-worktree": "px-2 pl-5",
  "remote-project": "px-2",
};
