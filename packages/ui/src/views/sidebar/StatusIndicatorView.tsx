import { FileDiff, FileQuestionMark } from "lucide-react";
import { worktreeSyncView } from "../../lib/syncState.ts";
import type { Worktree } from "@shigomori/contracts/schemas";
import { StatusPillView } from "./StatusPillView.tsx";
import { pluralize } from "@shigomori/contracts/words";

interface StatusIndicatorProps {
  worktree: Worktree;
}

// The palette's row has room for one pill, so uncommitted work wins and
// the remote state waits its turn. The sidebar's rows have the room for
// both, and render them side by side (WorktreeEntry).
export function StatusIndicatorView({ worktree }: StatusIndicatorProps) {
  return worktree.changedCount !== 0 ? (
    <ChangedFilesPillView worktree={worktree} />
  ) : (
    <RemoteSyncPillView worktree={worktree} />
  );
}

// Renders nothing on a clean tree, so the sidebar's rows can place it
// unconditionally alongside the remote pill. A tree whose changes
// couldn't be read isn't clean, and has no count.
export function ChangedFilesPillView({ worktree }: StatusIndicatorProps) {
  const count = worktree.changedCount;
  if (count === 0) return null;
  if (count === null) {
    const label = "Couldn't read its changes";
    return (
      <StatusPillView
        icon={FileQuestionMark}
        tone="amber"
        tip={label}
        aria-label={label}
      />
    );
  }
  const label = `${pluralize(count, "file")} changed`;
  return (
    <StatusPillView icon={FileDiff} tone="amber" tip={label} aria-label={label}>
      {count}
    </StatusPillView>
  );
}

// Just a "needs attention" signal for the sidebar: icon and count, in
// the state's tone (lib/syncState). The detail header carries the
// actions and full labels.
export function RemoteSyncPillView({ worktree }: StatusIndicatorProps) {
  const { badge } = worktreeSyncView(worktree);
  if (!badge) return null;
  return (
    <StatusPillView
      icon={badge.Icon}
      tone={badge.tone}
      tip={badge.tip}
      aria-label={badge.label}
    >
      {badge.count}
    </StatusPillView>
  );
}
