import { deriveRemoteSyncState, type Worktree } from "@shared/schemas";

// Five buckets, deliberately coarser than the sidebar's status pills:
// the menu bar is a glance surface, so a worktree gets exactly one dot
// and one short number. Ordered most- to least-urgent -- the index into
// this list doubles as the sort key.
export const TRAY_STATUS_ORDER = [
  "attention",
  "dirty",
  "behind",
  "ahead",
  "clean",
] as const;

export type TrayStatus = (typeof TRAY_STATUS_ORDER)[number];

export interface TrayStatusInfo {
  status: TrayStatus;
  // Sort key: lower is more urgent.
  rank: number;
  // Right-aligned count, or null for states with nothing to count.
  label: string | null;
  // Spelled out for the row's tooltip and its accessible name.
  title: string;
}

function commits(n: number): string {
  return `${n} commit${n === 1 ? "" : "s"}`;
}

function info(
  status: TrayStatus,
  label: string | null,
  title: string,
): TrayStatusInfo {
  return { status, rank: TRAY_STATUS_ORDER.indexOf(status), label, title };
}

// Which single state a worktree gets to show.
//
// Conflicting divergence outranks everything: it's the one state where
// no obvious next action exists. Uncommitted work comes next -- it's the
// signal that says "something is in flight here". Only then does the
// remote relationship get a say.
//
// Detached HEAD maps to "clean" rather than a sixth bucket, matching the
// sidebar's deliberate choice to stay silent about it (see
// sidebar/StatusIndicator.tsx): it's a state this app rarely produces,
// and a permanently-lit dot would train the eye to ignore the color.
export function trayStatus(worktree: Worktree): TrayStatusInfo {
  const sync = deriveRemoteSyncState(worktree);
  if (sync.kind === "diverged") {
    return info(
      "attention",
      `${sync.ahead}↑${sync.behind}↓`,
      `Diverged: ${sync.ahead} ahead, ${sync.behind} behind`,
    );
  }
  if (worktree.changedCount > 0) {
    const noun = worktree.changedCount === 1 ? "file" : "files";
    return info(
      "dirty",
      String(worktree.changedCount),
      `${worktree.changedCount} ${noun} changed`,
    );
  }
  switch (sync.kind) {
    case "behind":
      return info(
        "behind",
        `${sync.behind}↓`,
        `${commits(sync.behind)} to pull`,
      );
    case "pullAndPush":
      return info(
        "behind",
        `${sync.ahead}↑${sync.behind}↓`,
        `${sync.ahead} ahead, ${sync.behind} behind -- mergeable`,
      );
    case "ahead":
      return info("ahead", `${sync.ahead}↑`, `${commits(sync.ahead)} to push`);
    case "publish":
      return sync.canPublish
        ? info("ahead", "new", "Branch not yet published")
        : info("clean", null, "Up to date");
    default:
      return info("clean", null, "Up to date");
  }
}

// Relevance order within a project: urgent first, then alphabetical so
// equally-calm worktrees never trade places between openings.
export function byRelevance(a: Worktree, b: Worktree): number {
  const rankDelta = trayStatus(a).rank - trayStatus(b).rank;
  if (rankDelta !== 0) return rankDelta;
  return a.name.localeCompare(b.name);
}
