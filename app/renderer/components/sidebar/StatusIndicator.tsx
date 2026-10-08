import { FileDiff } from "lucide-react";
import { worktreeSyncView } from "@/lib/syncState";
import type { Worktree } from "@shigomori/contracts/schemas";
import { StatusPill } from "./StatusPill";

interface StatusIndicatorProps {
  worktree: Worktree;
}

// The palette's row has room for one pill, so uncommitted work wins and
// the remote state waits its turn. The sidebar's rows have the room for
// both, and render them side by side (WorktreeEntry).
export function StatusIndicator({ worktree }: StatusIndicatorProps) {
  return worktree.changedCount > 0 ? (
    <ChangedFilesPill worktree={worktree} />
  ) : (
    <RemoteSyncPill worktree={worktree} />
  );
}

// Renders nothing on a clean tree, so the sidebar's rows can place it
// unconditionally alongside the remote pill.
export function ChangedFilesPill({ worktree }: StatusIndicatorProps) {
  if (worktree.changedCount === 0) return null;
  const noun = worktree.changedCount === 1 ? "file" : "files";
  const label = `${worktree.changedCount} ${noun} changed`;
  return (
    <StatusPill icon={FileDiff} tone="amber" tip={label} aria-label={label}>
      {worktree.changedCount}
    </StatusPill>
  );
}

// Just a "needs attention" signal for the sidebar: icon and count, in
// the state's tone (lib/syncState). The detail header carries the
// actions and full labels.
export function RemoteSyncPill({ worktree }: StatusIndicatorProps) {
  const { badge } = worktreeSyncView(worktree);
  if (!badge) return null;
  return (
    <StatusPill
      icon={badge.Icon}
      tone={badge.tone}
      tip={badge.tip}
      aria-label={badge.label}
    >
      {badge.count}
    </StatusPill>
  );
}
