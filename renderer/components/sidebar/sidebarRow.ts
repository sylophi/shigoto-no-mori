import type { StackChild, StackPosition } from "@shared/pullRequestStack";
import type { DeviceIcon } from "@shared/account/deviceIcon";
import type { Project, PullRequest, Worktree } from "@shared/schemas";
import type { StatusTone } from "@/components/ui/status-dot";
import type { SidebarDeviceBadge } from "./DeviceBadge";

// The two shelves the inbox view folds shut by default. The third box
// (the live one) has no header and no toggle, so it isn't in this union.
export type InboxShelf = "shelved" | "merged";

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
  // peer's, standing in for the group. `groupId` is what the fold is
  // kept under and what the group's rows report their hover to: the
  // local project's id, or a peer-only group's (remoteGroupId).
  // `devices` lists the peer devices in the group (empty for a purely
  // local project), for the header's badge cluster, and `members` the
  // same peers' checkouts, for the header's actions. A peer-only group
  // may span several devices sharing one repo identity.
  | {
      kind: "project";
      key: string;
      groupId: string;
      project: Project;
      local: boolean;
      expanded: boolean;
      devices: readonly SidebarDeviceBadge[];
      members: readonly RemoteProjectMember[];
    }
  // A local worktree. `mirror` names the peer device it is kept in
  // step with (a live mirror either way round), in which case the
  // peer's own row for the pair is folded into this one.
  | {
      kind: "worktree";
      key: string;
      worktree: Worktree;
      mirror?: SidebarDeviceBadge;
      // The PR's place in its stack, off the project's map, and its
      // place under the stack's lowest row when the two sit together
      // (shared/pullRequestStack.ts).
      stack: StackPosition | null;
      stackChild?: StackChild;
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
      // worktree row wears the same).
      mirror?: SidebarDeviceBadge;
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
      deviceId: string;
      deviceLabel: string;
      deviceIcon: DeviceIcon;
      // False renders the row faded: the device is off and this is its
      // last known state.
      reachable: boolean;
      // The device's connection tone, for its badge on the row.
      tone: StatusTone;
      // Its PR on that device, off the peer's own map like a local
      // row's off this machine's.
      pr: PullRequest | undefined;
      stack: StackPosition | null;
      stackChild?: StackChild;
      groupId: string;
    }
  | {
      kind: "shelved-toggle";
      key: string;
      // The shelf is the group's: a local project's, or a peer-only
      // group's (remoteGroupId).
      groupId: string;
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
  // Shown instead of the list when the view has nothing to render and
  // isn't merely still resolving. Null means "say nothing". That
  // includes the loading case, since a flash of "nothing here" while the
  // answer is still in flight is worse than a beat of blank space.
  emptyMessage: string | null;
  // Which row to scroll to when navigation lands on a worktree from
  // outside the sidebar. Falls back to whatever contains it when its own
  // row isn't rendered (a folded project in the tree, a folded shelf in
  // the inbox), and null when the view can't place it at all. Neither
  // view unfolds anything on the way: the empty-state redirect runs on
  // every launch, and auto-expanding would undo the user's folding.
  // A deviceId names a peer's worktree (the device-scoped twin route);
  // absent, the worktree is this machine's.
  revealKey: (
    projectId: string,
    worktreeId: string,
    deviceId?: string,
  ) => string | null;
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
};
