import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";
import type { SidebarDeviceBadge } from "./DeviceBadge";
import type { PullRequest, Worktree } from "@shared/schemas";
import type { StackChild, StackPosition } from "@shared/pullRequestStack";
import { useWorktreeRowState } from "./useWorktreeRowState";
import { WorktreeEntry } from "./WorktreeEntry";

interface WorktreeRowProps {
  worktree: Worktree;
  // The peer device a peer's worktree lives on, for its badge beside
  // the worktree's name. Absent, the worktree is this machine's.
  device?: SidebarDeviceBadge;
  // The peer this worktree is mirrored with, when it is: the row then
  // stands for both copies and wears the peer's badge.
  mirror?: SidebarDeviceBadge;
  pr: PullRequest | undefined;
  // Both off the tree builder, which places the project's rows by
  // stack once (buildSidebarRows).
  stack: StackPosition | null;
  stackChild?: StackChild;
}

// A stack's rows draw as a file tree: the lowest layer is the parent
// and every layer built on it a child one step in, hung on the same
// connectors a file tree uses (a tee, the last child a corner). The
// connector is filled strips rather than a bordered box: doubutsu
// clears every border color, and a connector that vanishes with the
// theme would leave the indent unexplained. Its upright reaches up
// across the gap over the row (--row-gap, ROW_LAYOUT) to meet the one
// above.
const STACK_CHILD_INSET_PX = 12;

function stackIndentStyle(
  child: StackChild | undefined,
): CSSProperties | undefined {
  if (!child) return undefined;
  return {
    marginLeft: STACK_CHILD_INSET_PX,
    width: `calc(100% - ${STACK_CHILD_INSET_PX}px)`,
  };
}

function StackConnector({ child }: { child: StackChild | undefined }) {
  if (!child) return null;
  return (
    <span aria-hidden className="absolute inset-y-0 -left-2 w-1.5">
      <span
        className={cn(
          "absolute top-[calc(var(--row-gap,0px)*-1)] left-0 w-px bg-muted-foreground/40",
          child === "last" ? "h-[calc(50%+var(--row-gap,0px))]" : "bottom-0",
        )}
      />
      <span className="absolute inset-x-0 top-1/2 h-px bg-muted-foreground/40" />
    </span>
  );
}

// A worktree in the sidebar tree, this machine's or a peer device's:
// the inbox's row without its context line of project and time, since
// the tree shows one project at a time (WorktreeEntry). A peer's row is
// the same row plus its device badge. Everything else reads as local:
// the PR off the peer's own map, script activity off its run store,
// and a click opens the worktree's page under its device's route.
export function WorktreeRow({
  worktree,
  device,
  mirror,
  pr,
  stack,
  stackChild,
}: WorktreeRowProps) {
  // A peer's row takes the local row's own rule, scoped to the device:
  // the open remote worktree reads as selected like a local one.
  const state = useWorktreeRowState(worktree, device?.deviceId);
  return (
    <WorktreeEntry
      worktree={worktree}
      pr={pr}
      stack={stack}
      device={device}
      mirror={mirror}
      state={state}
      style={stackIndentStyle(stackChild)}
    >
      <StackConnector child={stackChild} />
    </WorktreeEntry>
  );
}
