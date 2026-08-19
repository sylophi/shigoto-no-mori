import {
  ArrowDown,
  ArrowDownUp,
  ArrowUp,
  CloudUpload,
  FileDiff,
  GitCompareArrows,
} from "lucide-react";
import { assertNever } from "@/lib/utils";
import { deriveRemoteSyncState, type Worktree } from "@shared/schemas";
import { StatusPill } from "./StatusPill";

interface StatusIndicatorProps {
  worktree: Worktree;
}

// The classic sidebar row has room for one pill, so uncommitted work wins
// and the remote state waits its turn. The inbox row is taller and asks a
// different question -- "what is going on here" rather than "which row is
// this" -- so it renders both pills itself.
export function StatusIndicator({ worktree }: StatusIndicatorProps) {
  return worktree.changedCount > 0 ? (
    <ChangedFilesPill worktree={worktree} />
  ) : (
    <RemoteSyncPill worktree={worktree} />
  );
}

// Renders nothing on a clean tree, so the inbox row can place it
// unconditionally alongside the remote pill.
export function ChangedFilesPill({ worktree }: StatusIndicatorProps) {
  if (worktree.changedCount === 0) return null;
  const noun = worktree.changedCount === 1 ? "file" : "files";
  const label = `${worktree.changedCount} ${noun} changed`;
  return (
    <StatusPill icon={FileDiff} tone="amber" title={label} aria-label={label}>
      {worktree.changedCount}
    </StatusPill>
  );
}

export function RemoteSyncPill({ worktree }: StatusIndicatorProps) {
  const state = deriveRemoteSyncState(worktree);

  // Each remote-sync state has the same compact shape: icon + (optional)
  // count, tone-colored. The detail header carries the actions and full
  // labels; this is just a "needs attention" signal for the sidebar.
  switch (state.kind) {
    case "detached":
    case "synced":
      return null;
    case "publish":
      // Without a remote there's no action to take, so the icon would just be
      // noise on every "personal" repo without an origin. Detail header still
      // shows the disabled Publish button for discoverability.
      if (!state.canPublish) return null;
      return (
        <StatusPill
          icon={CloudUpload}
          tone="violet"
          title="Branch not yet published"
          aria-label="Unpublished branch"
        />
      );
    case "ahead":
      return (
        <StatusPill
          icon={ArrowUp}
          tone="emerald"
          title={`${state.ahead} commit${state.ahead === 1 ? "" : "s"} to push`}
          aria-label={`${state.ahead} ahead`}
        >
          {state.ahead}
        </StatusPill>
      );
    case "behind":
      return (
        <StatusPill
          icon={ArrowDown}
          tone="sky"
          title={`${state.behind} commit${state.behind === 1 ? "" : "s"} to pull`}
          aria-label={`${state.behind} behind`}
        >
          {state.behind}
        </StatusPill>
      );
    case "pullAndPush":
      return (
        <StatusPill
          icon={ArrowDownUp}
          tone="indigo"
          title={`${state.ahead} ahead, ${state.behind} behind -- mergeable`}
          aria-label={`${state.ahead} ahead, ${state.behind} behind`}
        >
          {state.ahead}/{state.behind}
        </StatusPill>
      );
    case "diverged":
      return (
        <StatusPill
          icon={GitCompareArrows}
          tone="rose"
          title={`Diverged: ${state.ahead} ahead, ${state.behind} behind`}
          aria-label={`Diverged ${state.ahead}/${state.behind}`}
        >
          {state.ahead}/{state.behind}
        </StatusPill>
      );
    default:
      return assertNever(state);
  }
}
