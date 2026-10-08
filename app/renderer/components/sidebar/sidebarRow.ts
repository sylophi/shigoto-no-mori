import type { StackPosition, StackRail } from "@shared/pullRequestStack";
import type { DeviceIcon } from "@shared/account/deviceIcon";
import type { Project, PullRequest, Worktree } from "@shared/schemas";
import type { SidebarDeviceBadge } from "./DeviceBadge";

// The shelves the inbox view folds shut by default. The live box has
// no header and no toggle, so it isn't in this union.
export type InboxShelf = "agentWorking" | "shelved" | "merged" | "hidden";

// Each shelf's name, as its fold reads it.
export const SHELF_LABELS: Record<InboxShelf, string> = {
  agentWorking: "Agent working",
  shelved: "Shelved",
  merged: "Merged",
  hidden: "Hidden",
};

// The folds under a tree group's rows, in order: the worktrees an agent
// is working in (isAgentWorking), those the user shelved, and those the
// hidden prefixes match.
export const GROUP_SHELVES = ["agentWorking", "shelved", "hidden"] as const;
export type GroupShelf = (typeof GROUP_SHELVES)[number];

// One peer device's checkout of a project group.
export interface RemoteProjectMember {
  deviceId: string;
  deviceLabel: string;
  deviceIcon: DeviceIcon;
  project: Project;
}

export type SidebarRow =
  // A project header, for one repo wherever it is checked out: on this
  // machine with any peers' checkouts merged in, or on peers alone.
  // `project` is this machine's checkout when `local`, else the first
  // peer's, standing in for the group. `groupId` is what a pick off
  // the list names and what the group's rows report their hover to:
  // the local project's id, or a peer-only group's (remoteGroupId).
  // `expanded` is the open project, heading the tree on its own.
  // `devices` lists the peer devices in the group (empty for a purely
  // local project), for the header's badge cluster, and `members` the
  // same peers' checkouts, for the header's actions. A peer-only group
  // may span several devices sharing one repo identity.
  | {
      kind: "project";
      key: string;
      groupId: string;
      // What the shell keeps the open project by (projectGroupKey):
      // the same for a repo however the device filter draws its group.
      groupKey: string;
      project: Project;
      local: boolean;
      expanded: boolean;
      // On the list of projects, the worktrees the group holds beside
      // its primary checkouts. Undefined on the open project, while
      // arranging, and while its listing is loading or failed.
      branches?: number;
      devices: readonly SidebarDeviceBadge[];
      members: readonly RemoteProjectMember[];
      // Pinned to the top of the list (ProjectGroupOrder.pinned).
      pinned: boolean;
      // The last of the pinned projects leading the list, with more
      // after it: a gap under it parts them from the rest.
      pinnedEnd?: boolean;
    }
  // A local worktree. `mirror` names the peer device it is kept in
  // step with (a live mirror either way round), in which case the
  // peer's own row for the pair is folded into this one.
  | {
      kind: "worktree";
      key: string;
      worktree: Worktree;
      mirror?: SidebarDeviceBadge;
      // The peer's copy the row stands for too, whose page selects it.
      mirrorWorktreeId?: string;
      // Its PR off the project's map, which the builder already holds
      // (as the inbox row's, see below).
      pr: PullRequest | undefined;
      // The PR's place in its stack, off the project's map, and its
      // stop on the stack's rail when its rows sit together
      // (shared/pullRequestStack.ts).
      stack: StackPosition | null;
      stackRail?: StackRail;
      // The fold the row was filed behind, null for the group's open
      // rows. The row fades by it (WorktreeEntry).
      shelf: GroupShelf | null;
    }
  // The inbox's own row: taller, cross-project, and built to be triaged
  // rather than picked out of a short list. See InboxRow. The project
  // and PR ride along because the builder already had both in hand.
  // Resolving either again per row would put a query observer on every
  // visible row for an answer it already knew. A peer's worktree files
  // here beside this machine's, carrying its device. Absent, the row
  // is local.
  | {
      kind: "inbox-worktree";
      key: string;
      worktree: Worktree;
      project: Project;
      pr: PullRequest | undefined;
      // The PR's place in its stack, off the same map as `pr`.
      stack: StackPosition | null;
      device: SidebarDeviceBadge | undefined;
      // The peer a local row is mirrored with, when it is (the tree's
      // worktree row wears the same), and its copy there.
      mirror?: SidebarDeviceBadge;
      mirrorWorktreeId?: string;
      // The shelf the row was filed on, null for live work.
      shelf: InboxShelf | null;
    }
  | { kind: "worktree-skeleton"; key: string; projectId: string }
  | { kind: "worktree-error"; key: string; projectId: string }
  // A peer device's worktree, merged into the tree beside the local
  // rows: under the local project sharing its repo identity when one
  // exists, else under a peer-only project header. groupId names the
  // group it renders in (its header's groupId) so hover attribution
  // works without re-deriving the merge.
  | {
      kind: "remote-worktree";
      key: string;
      worktree: Worktree;
      // The device's badge on the row, in its connection tone. Not
      // `reachable` renders the row faded: the device is off and this
      // is its last known state.
      device: SidebarDeviceBadge;
      // Its PR on that device, off the peer's own map like a local
      // row's off this machine's.
      pr: PullRequest | undefined;
      stack: StackPosition | null;
      stackRail?: StackRail;
      shelf: GroupShelf | null;
      groupId: string;
    }
  // The head of an owner's run on the list of projects, when it is
  // split by owner (buildSidebarRows, ownerOf): the org or user the
  // projects below belong to. Shut, the projects are left out and
  // `count` stands for them.
  | {
      kind: "owner-header";
      key: string;
      ownerKey: string;
      label: string;
      count: number;
      expanded: boolean;
    }
  // The head of the open project's worktrees gathered by a prefix
  // (BuildSidebarRowsArgs.byPrefix). Shut, the rows are left out and
  // `count` stands for them.
  | {
      kind: "worktree-group";
      key: string;
      groupId: string;
      prefix: string;
      count: number;
      expanded: boolean;
    }
  | {
      kind: "shelved-toggle";
      key: string;
      // The shelf is the group's: a local project's, or a peer-only
      // group's (remoteGroupId).
      groupId: string;
      shelf: GroupShelf;
      count: number;
      expanded: boolean;
    }
  | {
      kind: "inbox-shelf";
      key: string;
      shelf: InboxShelf;
      count: number;
      expanded: boolean;
    }
  // The head of the inbox's live work gathered by a prefix, the
  // inbox's "worktree-group".
  | {
      kind: "inbox-group";
      key: string;
      prefix: string;
      count: number;
      expanded: boolean;
    };

// What a view hands the sidebar shell. Both row builders produce this,
// so the shell renders one of them without knowing which.
export interface SidebarViewModel {
  rows: SidebarRow[];
  // A row held still over the list rather than scrolled with it: the
  // open project's header, naming whatever the rows are scrolled to.
  pinned?: SidebarRow;
  // Where a view with levels is: null on the tree's list of projects,
  // the open project's group key inside one. Absent for a view with
  // none (the inbox, arranging).
  level?: string | null;
  // Shown instead of the list when the view has nothing to render and
  // isn't merely still resolving. Null means "say nothing". That
  // includes the loading case, since a flash of "nothing here" while the
  // answer is still in flight is worse than a beat of blank space.
  emptyMessage: string | null;
  // Which row to scroll to when navigation lands on a worktree from
  // outside the sidebar. Falls back to the fold's toggle when its own
  // row is behind a shut shelf (the list opens it, SidebarList), and
  // null when the view can't place it at all, or not yet: the tree
  // opens the project of the page on screen itself (Sidebar), and the
  // row is revealed once it draws.
  // A deviceId names a peer's worktree; absent, the worktree is this
  // machine's.
  revealKey: (
    projectId: string,
    worktreeId: string,
    deviceId?: string,
  ) => string | null;
  // Whether the view leaves a listed worktree out by design, so it will
  // have no row for it however long it is given (the inbox, which
  // keeps primaries out). Absent for a view that lists every worktree.
  leftOut?: (worktreeId: string, deviceId?: string) => boolean;
}

export const ROW_SIZE_HINTS: Record<SidebarRow["kind"], number> = {
  project: 28,
  "owner-header": 32,
  worktree: 49,
  "worktree-skeleton": 36,
  "worktree-error": 24,
  "worktree-group": 32,
  "shelved-toggle": 24,
  "inbox-worktree": 66,
  "inbox-shelf": 36,
  "inbox-group": 36,
  "remote-worktree": 49,
};

// The phone layout draws the same rows on a larger scale, and never
// shorter than its touch target (phone.css). A hint that ignored that
// would have the reveal scroll land short of a row not yet measured.
const PHONE_ROW_SCALE = 1.15;
const PHONE_ROW_MIN = 44;
export function rowSizeHint(kind: SidebarRow["kind"], phone: boolean): number {
  const hint = ROW_SIZE_HINTS[kind];
  return phone
    ? Math.max(Math.round(hint * PHONE_ROW_SCALE), PHONE_ROW_MIN)
    : hint;
}

// Where the row sits in the scroller, read off the kind rather than
// handed down from the view, so the virtualizer never has to be told
// which layout it is drawing.
//
// The tree's rows sit flush with the project's name over them: only one
// project's rows ever show, so there is no group for an indent to mark
// off, and the width goes to the branch names instead. Worktree rows,
// the tree's and the inbox's alike, keep a gap under them. Rows of
// several lines butted together read as one block of text with nothing
// for the eye to break on.
//
// Worktree rows set their gap as --row-gap, which the tree's stack
// rail reads to reach across it to the next row's stop (WorktreeRow).
//
// Padding, not margin: the virtualizer sizes each row from offsetHeight,
// which counts the one and ignores the other, so a margin would let the
// next row overlap instead of parting them.
// The gap under every worktree row, the tree's and the inbox's alike.
const WORKTREE_ROW_GAP = "px-2 pb-(--row-gap) [--row-gap:--spacing(1)]";

export const ROW_LAYOUT: Record<SidebarRow["kind"], string> = {
  project: "px-2",
  "owner-header": "px-2",
  worktree: WORKTREE_ROW_GAP,
  "worktree-skeleton": "px-2",
  "worktree-error": "px-2",
  "worktree-group": "px-2",
  "shelved-toggle": "px-2",
  "inbox-worktree": WORKTREE_ROW_GAP,
  "inbox-shelf": "px-2 pb-1",
  "inbox-group": "px-2 pb-1",
  "remote-worktree": WORKTREE_ROW_GAP,
};
