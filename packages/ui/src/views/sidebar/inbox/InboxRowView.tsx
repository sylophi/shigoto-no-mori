// The inbox's row (InboxRow binds it): the tree's row
// (WorktreeEntryView) with the project and the time over it.
import type { ComponentProps, ReactNode } from "react";
import { SimpleTooltip } from "../../../primitives/tooltip.tsx";
import { useNow } from "../../../hooks/useNow.ts";
import { formatRelativeTime } from "../../../lib/relativeTime.ts";
import {
  worktreeLastActivityAt,
  type Project,
  type PullRequest,
  type Worktree,
} from "@shigomori/contracts/schemas/index";
import type { StackPosition } from "@shigomori/contracts/pullRequestStack";
import { ActivityIconView } from "../ActivityIconView.tsx";
import {
  DeviceBadgeView,
  MirrorBadgeView,
  type SidebarDeviceBadge,
} from "../DeviceBadgeView.tsx";
import { activityMark, type WorktreeRowLook } from "../rowLook.ts";
import type { InboxShelf } from "../sidebarRow.ts";
import type { WorktreeEntry } from "../WorktreeEntryView.tsx";
import { WorktreeEntryView } from "../WorktreeEntryView.tsx";

export interface InboxRowProps {
  worktree: Worktree;
  project: Project;
  pr: PullRequest | undefined;
  stack: StackPosition | null;
  // The peer this worktree lives on, or undefined for this machine's own.
  device: SidebarDeviceBadge | undefined;
  mirror?: SidebarDeviceBadge;
  mirrorWorktreeId?: string;
  shelf: InboxShelf | null;
}

// The inbox row answers a different question from the tree row. In the
// tree you already know the project, so its row is this one without
// the project line. Here every row comes from somewhere else and you're
// triaging: which repo, which branch, what state it's in, and when it
// last moved. The row itself is the tree's (WorktreeEntry), with the
// project and the time over it.
//
//   [icon] project                                  14m ago
//   feat/the-branch
//   [kind] dirname                             ±3  ↑2  #142
//
// Right-click opens the project's menu, the same list the tree hangs
// off a project header's `…`. The inbox has no project headers, so this
// is the only place its project-level actions can live. A peer's row
// wears its device badge beside the project name, opens under that
// device's route, and scopes that menu to the peer. Asleep, or taking no
// commands from here, it keeps the row (last known state) and drops the
// menu, as the tree's project header drops its actions.
export function InboxRowView({
  worktree,
  project,
  pr,
  stack,
  device,
  mirror,
  shelf,
  entry,
  projectIcon,
  ...button
}: Omit<InboxRowProps, "mirrorWorktreeId"> & {
  entry: WorktreeEntry;
  // The project's icon (ProjectIcon), read off the device it lives on.
  projectIcon: ReactNode;
} & Omit<ComponentProps<"button">, "children">) {
  const { marks } = entry;
  return (
    <WorktreeEntryView
      {...button}
      worktree={worktree}
      pr={pr}
      stack={stack}
      device={device}
      mirror={mirror}
      look={entry.look}
      onOpen={entry.open}
      resident={entry.resident}
      forwardTip={entry.forwardTip}
      marks={marks}
      shelf={shelf}
      context={
        <div className="flex min-w-0 items-center gap-1.5 text-3xs text-muted-foreground">
          {projectIcon}
          <SimpleTooltip whenTruncated tip={project.name}>
            <span className="min-w-0 truncate font-medium">{project.name}</span>
          </SimpleTooltip>
          {device && marks.deviceBadges && <DeviceBadgeView badge={device} />}
          {mirror && (
            <MirrorBadgeView mirror={mirror} showBadge={marks.deviceBadges} />
          )}
          <TrailingSlot worktree={worktree} look={entry.look} />
        </div>
      }
    />
  );
}

// Right end of the context line: normally "when did this last move",
// which is what the inbox sorts on. A running script or a delete in
// flight displaces it. Those are happening now, so they outrank a
// timestamp.
function TrailingSlot({
  worktree,
  look,
}: {
  worktree: Worktree;
  look: WorktreeRowLook;
}) {
  const mark = activityMark(look);
  const activityAt = worktreeLastActivityAt(worktree);
  const now = useNow();

  return (
    <span className="ml-auto flex shrink-0 items-center">
      {mark ? (
        <ActivityIconView kind={mark} />
      ) : (
        <span className="tabular">
          {activityAt > 0 ? formatRelativeTime(activityAt, now) : "no activity"}
        </span>
      )}
    </span>
  );
}
