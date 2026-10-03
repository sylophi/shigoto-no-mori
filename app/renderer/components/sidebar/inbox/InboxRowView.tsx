import type { ComponentProps, ReactNode } from "react";
import { formatRelativeTime } from "@/lib/relativeTime";
import { ProjectIconView } from "@/components/shared/ProjectIconView";
import {
  worktreeLastActivityAt,
  type Project,
  type Worktree,
} from "@shared/schemas";
import { ActivityIcon } from "../ActivityIcon";
import { DeviceBadge, MirrorBadgeView } from "../DeviceBadgeView";
import { activityMark, type WorktreeRowLook } from "../rowState";
import {
  WorktreeEntryView,
  type WorktreeEntryViewProps,
} from "../WorktreeEntryView";

type InboxRowViewProps = Omit<WorktreeEntryViewProps, "context"> & {
  project: Project;
  // The project's logo, as ProjectIconView takes it.
  projectIconSrc: string | null | undefined;
  // When the worktree last moved: ActivityAge, which follows the clock
  // on its own so a tick redraws it alone, or ActivityAgeView for a
  // picture.
  age: ReactNode;
};

// The inbox row answers a different question from the tree row. In the
// tree you already know the project, so its row is this one without
// the project line. Here every row comes from somewhere else and you're
// triaging: which repo, which branch, what state it's in, and when it
// last moved. The row itself is the tree's (WorktreeEntryView), with
// the project and the time over it.
//
//   [icon] project                                  14m ago
//   feat/the-branch                            ±3  ↑2  #142
//   [kind] dirname
//
// A peer's row wears its device badge beside the project name. Props
// pass through to the row's button, so a menu trigger can render it as
// its own element (InboxRow hangs the project's menu off it).
export function InboxRowView({
  project,
  projectIconSrc,
  age,
  ...entry
}: InboxRowViewProps & ComponentProps<"button">) {
  const { device, mirror, showDeviceBadges } = entry;
  return (
    <WorktreeEntryView
      {...entry}
      context={
        <div className="flex min-w-0 items-center gap-1.5 text-3xs text-muted-foreground">
          <ProjectIconView
            name={project.name}
            src={projectIconSrc}
            className="size-3"
          />
          {/* The row-* slots name a row's parts for the marketing
              site, whose pins point at them (marketing/src/pages). */}
          <span
            data-slot="row-project"
            className="min-w-0 truncate font-medium"
          >
            {project.name}
          </span>
          {device && showDeviceBadges && <DeviceBadge badge={device} />}
          {mirror && (
            <MirrorBadgeView mirror={mirror} showBadge={showDeviceBadges} />
          )}
          <TrailingSlot look={entry.look} age={age} />
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
  look,
  age,
}: {
  look: WorktreeRowLook;
  age: ReactNode;
}) {
  const mark = activityMark(look);
  return (
    <span
      data-slot="row-activity"
      className="ml-auto flex shrink-0 items-center"
    >
      {mark ? <ActivityIcon kind={mark} /> : age}
    </span>
  );
}

// "14m ago": when a worktree last moved, counted back from `now`.
export function ActivityAgeView({
  worktree,
  now,
}: {
  worktree: Worktree;
  now: number;
}) {
  const activityAt = worktreeLastActivityAt(worktree);
  return (
    <span className="tabular">
      {activityAt > 0 ? formatRelativeTime(activityAt, now) : "no activity"}
    </span>
  );
}
