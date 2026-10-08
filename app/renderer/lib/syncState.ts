// Presentation mapping for a worktree's remote-sync state. One place
// turns each kind into its icon, tone, words and safe move, so the
// sidebar badge, the sync pill, the palette's git verb and the changes
// page's clean-tree line say the same thing. The switch is exhaustive,
// so a new kind fails typecheck here until it says what it shows. The
// remote marker's "Up to date" stays outside on purpose: it stands in for
// the pill where the pill has nothing to say, and is the marker's own.
import {
  ArrowDown,
  ArrowDownUp,
  ArrowUp,
  CloudUpload,
  GitCompareArrows,
  type LucideIcon,
} from "lucide-react";
import { assertNever } from "./utils";
import { pluralize } from "./pluralize";
import {
  deriveRemoteSyncState,
  syncWaitsForCleanTree,
  type RemoteSyncState,
  type Worktree,
} from "@shared/schemas";

export type SyncTone = "violet" | "emerald" | "sky" | "indigo" | "rose";

// The sidebar's compact mark: icon and an optional count, in the tone.
interface SyncBadge {
  Icon: LucideIcon;
  tone: SyncTone;
  count?: string;
  tip: string;
  label: string;
}

// The one git move that is safe to offer without a confirm. The pill
// draws it as a button and the palette as its git verb.
export interface SyncMove {
  key: "push" | "pull" | "publish" | "pullAndPush";
  Icon: LucideIcon;
  tone: SyncTone;
  label: string;
  // For a narrow strip ("Push 2"), with `compactTip` as its tooltip.
  compactLabel: string;
  compactTip: string;
  // The tooltip at full width, when the label can't say what the move
  // runs.
  tip?: string;
  // Why it can't run, when it can't. The button stays up, disabled,
  // so the move is still discoverable.
  disabledReason?: string;
  // The label's own arrows already show which way it goes, so the pill
  // leaves the icon off.
  arrowsInLabel?: boolean;
}

// What the pill says instead of the move while uncommitted changes
// hold it back (syncWaitsForCleanTree).
interface SyncHeld {
  label: string;
  compactLabel?: string;
  tip: string;
  // Absent where the label's own arrows say which way it waits.
  Icon?: LucideIcon;
}

interface SyncStateView {
  // Null where the sidebar row stays quiet.
  badge: SyncBadge | null;
  move: SyncMove | null;
  // The words for a move held back by uncommitted changes, for the
  // states whose move waits for a clean tree.
  held: SyncHeld | null;
  // What the branch still owes the remote, as a sentence, for a tree
  // with everything committed.
  owed: string | null;
}

const PULL_AND_PUSH_RUNS =
  "git pull --rebase, falling back to a merge on conflict, then git push";

// "↑2↓3": both counts, for the states where both sides moved.
const both = (ahead: number, behind: number) => `↑${ahead}↓${behind}`;

function syncStateView(state: RemoteSyncState): SyncStateView {
  switch (state.kind) {
    case "detached":
      return { badge: null, move: null, held: null, owed: null };
    case "synced":
      return {
        badge: null,
        move: null,
        held: null,
        owed: "Everything is committed and pushed.",
      };
    case "publish": {
      const look = { Icon: CloudUpload, tone: "violet" } as const;
      return {
        // Without a remote there's no action to take, so a badge would
        // just be noise on every "personal" repo without an origin. The
        // pill still shows the disabled Publish button.
        badge: state.canPublish
          ? {
              ...look,
              tip: "Branch not yet published",
              label: "Unpublished branch",
            }
          : null,
        move: {
          ...look,
          key: "publish",
          label: "Publish branch",
          compactLabel: "Publish",
          compactTip: "Publish this branch to the remote",
          disabledReason: state.canPublish
            ? undefined
            : "No git remote is configured for this project",
        },
        held: null,
        owed: state.canPublish ? "This branch isn't on the remote yet." : null,
      };
    }
    case "ahead": {
      const look = { Icon: ArrowUp, tone: "emerald" } as const;
      const commits = pluralize(state.ahead, "commit");
      return {
        badge: {
          ...look,
          count: `${state.ahead}`,
          tip: `${commits} to push`,
          label: `${state.ahead} ahead`,
        },
        move: {
          ...look,
          key: "push",
          label: `Push ${commits}`,
          compactLabel: `Push ${state.ahead}`,
          compactTip: `Push ${commits} to the remote`,
        },
        held: null,
        owed: `${commits} not pushed yet.`,
      };
    }
    case "behind": {
      const look = { Icon: ArrowDown, tone: "sky" } as const;
      const commits = pluralize(state.behind, "commit");
      return {
        badge: {
          ...look,
          count: `${state.behind}`,
          tip: `${commits} to pull`,
          label: `${state.behind} behind`,
        },
        move: {
          ...look,
          key: "pull",
          label: `Pull ${commits}`,
          compactLabel: `Pull ${state.behind}`,
          compactTip: `Pull ${commits} from the remote`,
        },
        held: {
          label: `${commits} to pull`,
          compactLabel: `${state.behind} to pull`,
          Icon: ArrowDown,
          tip: `${commits} to pull. Commit or discard your changes to pull.`,
        },
        owed: `${commits} to pull.`,
      };
    }
    case "pullAndPush": {
      const look = { Icon: ArrowDownUp, tone: "indigo" } as const;
      const { ahead, behind } = state;
      return {
        badge: {
          ...look,
          count: `${ahead}/${behind}`,
          tip: `Mergeable: ${ahead} ahead, ${behind} behind`,
          label: `${ahead} ahead, ${behind} behind`,
        },
        move: {
          ...look,
          key: "pullAndPush",
          label: `Pull and push ${both(ahead, behind)}`,
          compactLabel: `Pull, push ${both(ahead, behind)}`,
          arrowsInLabel: true,
          compactTip: `Pull ${pluralize(behind, "commit")} and push ${pluralize(ahead, "commit")}: ${PULL_AND_PUSH_RUNS}`,
          tip: PULL_AND_PUSH_RUNS,
        },
        held: {
          label: `${both(ahead, behind)} to pull and push`,
          tip: `${pluralize(ahead, "commit")} to push and ${pluralize(behind, "commit")} to pull. Commit or discard your changes to pull and push.`,
        },
        owed: `${pluralize(ahead, "commit")} to push, ${pluralize(behind, "commit")} to pull.`,
      };
    }
    case "diverged": {
      const { ahead, behind } = state;
      return {
        badge: {
          Icon: GitCompareArrows,
          tone: "rose",
          count: `${ahead}/${behind}`,
          tip: `Diverged: ${ahead} ahead, ${behind} behind`,
          label: `Diverged ${ahead}/${behind}`,
        },
        // No safe move: a pull --rebase would almost certainly fail
        // mid-flight, so only the pill's overwrites remain (PickSide).
        move: null,
        held: {
          label: `Diverged ${both(ahead, behind)}`,
          tip: `History has split: ${ahead} local, ${behind} remote. Commit or discard your changes to pick which side wins.`,
        },
        owed: "History has split from the remote. Pick which side wins below.",
      };
    }
    default:
      return assertNever(state);
  }
}

export type WorktreeSyncView = SyncStateView & {
  state: RemoteSyncState;
  // Uncommitted changes hold the move back: `move` is null, and the
  // pill says `held` instead.
  waiting: boolean;
};

// The view for a worktree as it stands, its tree's changes included.
export function worktreeSyncView(worktree: Worktree): WorktreeSyncView {
  const state = deriveRemoteSyncState(worktree);
  const view = syncStateView(state);
  const waiting = worktree.changedCount > 0 && syncWaitsForCleanTree(state);
  return { ...view, state, waiting, move: waiting ? null : view.move };
}

// Whether the primary branch has commits to take in that this worktree
// can take now: a rebase or merge needs a clean tree, so the move waits
// rather than surfacing a git failure after the click.
export function canSyncFromPrimary(worktree: Worktree): boolean {
  return (
    !worktree.isPrimary &&
    !worktree.detached &&
    worktree.changedCount === 0 &&
    worktree.behindPrimary > 0
  );
}
