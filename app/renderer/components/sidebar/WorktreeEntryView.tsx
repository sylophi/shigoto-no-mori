import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";
import { BranchLabel } from "@/components/ui/branch-label";
import { VillagerFace } from "@/components/shared/VillagerSays";
import { WorktreeKindIcon } from "@/components/shared/WorktreeKindIcon";
import { BirthdayBadge } from "@/components/villagers/BirthdayBadge";
import type { Resident } from "@/hooks/villagers/useResident";
import type { StackPosition } from "@shared/pullRequestStack";
import type { PullRequest, Worktree } from "@shared/schemas";
import { ActivityIcon } from "./ActivityIcon";
import {
  DeviceBadge,
  MirrorBadgeView,
  type SidebarDeviceBadge,
} from "./DeviceBadgeView";
import { ForwardMarkView } from "./ForwardMarkView";
import { PullRequestPill } from "./PullRequestPill";
import { activityMark, type WorktreeRowLook } from "./rowState";
import type { InboxShelf } from "./sidebarRow";
import { ChangedFilesPill, RemoteSyncPill } from "./StatusIndicator";

export interface WorktreeEntryViewProps extends ComponentProps<"button"> {
  worktree: Worktree;
  pr: PullRequest | undefined;
  stack: StackPosition | null;
  // The peer the worktree lives on, absent for this machine's own, and
  // the peer a local one is mirrored with.
  device?: SidebarDeviceBadge;
  mirror?: SidebarDeviceBadge;
  look: WorktreeRowLook;
  // The fold or shelf the row was filed behind (sidebarRow), null for
  // the open rows.
  shelf: InboxShelf | null;
  // The inbox's line over the branch, naming the project and when the
  // worktree last moved, with the device marks and what's running.
  // Absent (the tree, which shows one project at a time), those marks
  // fold into the two lines below.
  context?: ReactNode;
  // What useWorktreeEntry looks up: the villager who lives here, the
  // ports forwarded from it, and whether this window shows device
  // badges on rows (Settings, Appearance).
  resident: Resident | null;
  forwardTip: string | undefined;
  showDeviceBadges: boolean;
}

// A worktree in the sidebar, the tree's row (WorktreeRowView) and the
// inbox's (InboxRowView) alike: the branch with every status the row has
// room for, over the worktree's own name.
//
//   [icon] project                                  14m ago   (inbox)
//   feat/the-branch                            ±3  ↑2  #142
//   [kind] dirname [device]
//
// Without a context line, a running script's mark leads the pills, and
// a delete in flight takes their place: the worktree is going away, so
// the trash standing alone reads as "destroying". Children lead the
// button (the tree's stack connector). Props pass through to the
// button, so a menu trigger can render it as its own element.
export function WorktreeEntryView({
  worktree,
  pr,
  stack,
  device,
  mirror,
  look,
  shelf,
  context,
  resident,
  forwardTip,
  showDeviceBadges,
  className,
  children,
  ...button
}: WorktreeEntryViewProps) {
  const { isSelected, isDeleting } = look;
  // The tree's row, which has no context line to carry these marks.
  const inline = context === undefined;
  const mark = inline ? activityMark(look) : null;
  return (
    <button
      type="button"
      title={look.title}
      {...button}
      className={cn(
        "relative flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors",
        // data-popup-open is Base UI's mark on a trigger whose menu is
        // up (the inbox row's): keep the row lit so it's clear whose
        // menu this is.
        "hover:bg-accent/60 focus-visible:outline-2 focus-visible:outline-ring data-popup-open:bg-accent/60",
        isSelected && "bg-accent text-accent-foreground",
        // One fade, the strongest that applies: a delete in flight, then
        // an unreachable device's last known state, then a row the user
        // filed away, shelved or behind a hidden prefix. Merged is git's
        // call, not theirs, so it keeps full strength.
        isDeleting
          ? "opacity-50"
          : device && !device.reachable
            ? "opacity-60"
            : shelf !== null &&
              shelf !== "merged" &&
              !isSelected &&
              "opacity-70",
        className,
      )}
    >
      {children}
      {context}
      <span className="flex min-w-0 items-center gap-1.5">
        {/* Weight is reserved for "this is the one you have open".
            Bolding every branch spends the page's only emphasis on the
            thing every row has. */}
        <span
          data-slot="row-branch"
          className={cn(
            "min-w-0 flex-1 truncate font-mono text-xs",
            isSelected && "font-medium",
          )}
          title={worktree.detached ? "Detached HEAD (commit hash)" : undefined}
        >
          <BranchLabel branch={worktree.branch} detached={worktree.detached} />
        </span>
        {mark && <ActivityIcon kind={mark} />}
        {!(inline && isDeleting) && (
          <>
            <ChangedFilesPill worktree={worktree} />
            <RemoteSyncPill worktree={worktree} />
            <PullRequestPill pr={pr} stack={stack} />
          </>
        )}
      </span>
      {/* The worktree's own name gets a line to itself rather than
          sharing one with the project: they're both "where is this",
          and side by side the longer one just eats the other. */}
      <span className="flex min-w-0 items-center gap-1 text-3xs text-muted-foreground/70">
        <EntryName worktree={worktree} resident={resident} />
        {/* Pulled in vertically: the device tile stands taller than the
            line, and letting it set the line's height would make a
            peer's row taller than a local one. The forward mark rides
            here on either row: it is about this worktree, not where it
            lives, which the inbox's context line says. */}
        <span className="-my-1 inline-flex shrink-0 items-center gap-1">
          {device && <ForwardMarkView tip={forwardTip} />}
          {inline && mirror && (
            <MirrorBadgeView mirror={mirror} showBadge={showDeviceBadges} />
          )}
          {inline && device && showDeviceBadges && (
            <DeviceBadge badge={device} />
          )}
        </span>
      </span>
    </button>
  );
}

// The worktree's own name, led by its kind glyph. Shelved is the one
// kind left out: it would restate the shelf the row already sits
// under. The primary's house glyph stays, since it's what tells the
// root apart from a worktree named after the project. Under Village
// life, the villager whose home this is sits beside the name, as their
// face sits beside the title on the worktree page. It's decoration
// here, so it stays out of the row's label and hover title.
function EntryName({
  worktree,
  resident,
}: {
  worktree: Worktree;
  resident: Resident | null;
}) {
  return (
    <>
      {!worktree.shelved && (
        <WorktreeKindIcon worktree={worktree} showTooltip={false} />
      )}
      {resident?.face && (
        <VillagerFace
          face={resident.face}
          tint={false}
          className="-my-0.5 size-3.5"
        />
      )}
      <span data-slot="row-name" className="min-w-0 truncate">
        {worktree.name}
      </span>
      <BirthdayBadge resident={resident} />
    </>
  );
}
