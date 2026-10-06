import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";
import { worktreeTitle } from "@/lib/worktreeTitle";
import { BranchLabel } from "@/components/ui/branch-label";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { VillagerFace } from "@/components/shared/VillagerSays";
import { WorktreeKindIcon } from "@/components/shared/WorktreeKindIcon";
import { BirthdayBadge } from "@/components/villagers/BirthdayBadge";
import { useResident } from "@/hooks/villagers/useResident";
import type { StackPosition } from "@shared/pullRequestStack";
import type { PullRequest, Worktree } from "@shared/schemas";
import { ActivityIcon } from "./ActivityIcon";
import {
  MirrorBadge,
  RowDeviceBadge,
  type SidebarDeviceBadge,
} from "./DeviceBadge";
import { ForwardMark } from "./ForwardMark";
import { PullRequestPill } from "./PullRequestPill";
import type { InboxShelf } from "./sidebarRow";
import { ChangedFilesPill, RemoteSyncPill } from "./StatusIndicator";
import { activityMark, type WorktreeRowState } from "./useWorktreeRowState";

interface WorktreeEntryProps extends ComponentProps<"button"> {
  worktree: Worktree;
  pr: PullRequest | undefined;
  stack: StackPosition | null;
  // The peer the worktree lives on, absent for this machine's own, and
  // the peer a local one is mirrored with.
  device: SidebarDeviceBadge | undefined;
  mirror: SidebarDeviceBadge | undefined;
  state: WorktreeRowState;
  // The fold or shelf the row was filed behind (sidebarRow), null for
  // the open rows.
  shelf: InboxShelf | null;
  // The inbox's line over the branch, naming the project and when the
  // worktree last moved, with the device marks and what's running.
  // Absent (the tree, which shows one project at a time), those marks
  // fold into the two lines below.
  context?: ReactNode;
}

// A worktree in the sidebar, the tree's row (WorktreeRow) and the
// inbox's (InboxRow) alike: what the work is called (its PR's title,
// or the one `sm describe` gave it, else the branch) with every status
// the row has room for, over the worktree's own name.
//
//   [icon] project                                  14m ago   (inbox)
//   Name the work before the PR                ±3  ↑2  #142
//   [kind] dirname [device]
//
// Without a context line, a running script's mark leads the pills, and
// a delete in flight takes their place: the worktree is going away, so
// the trash standing alone reads as "destroying". Children lead the
// button (the tree's stack connector). Props pass through to the
// button, so a menu trigger can render it as its own element.
export function WorktreeEntry({
  worktree,
  pr,
  stack,
  device,
  mirror,
  state,
  shelf,
  context,
  className,
  children,
  onClick,
  ...button
}: WorktreeEntryProps) {
  const { isSelected, isDeleting } = state;
  // The tree's row, which has no context line to carry these marks.
  const inline = context === undefined;
  const mark = inline ? activityMark(state) : null;
  const title = worktreeTitle(worktree, pr);
  return (
    <button
      type="button"
      {...button}
      onClick={(event) => {
        onClick?.(event);
        state.open();
      }}
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
            Bolding every title spends the page's only emphasis on the
            thing every row has. */}
        <SimpleTooltip whenTruncated tip={title ?? worktree.branch}>
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-xs",
              title === null && "font-mono",
              isSelected && "font-medium",
            )}
          >
            {title ?? (
              <BranchLabel
                branch={worktree.branch}
                detached={worktree.detached}
              />
            )}
          </span>
        </SimpleTooltip>
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
        <EntryName worktree={worktree} />
        {/* Pulled in vertically: the device tile stands taller than the
            line, and letting it set the line's height would make a
            peer's row taller than a local one. The forward mark rides
            here on either row: it is about this worktree, not where it
            lives, which the inbox's context line says. */}
        <span className="-my-1 inline-flex shrink-0 items-center gap-1">
          {device && (
            <ForwardMark deviceId={device.deviceId} worktree={worktree} />
          )}
          {inline && mirror && <MirrorBadge mirror={mirror} />}
          {inline && device && <RowDeviceBadge badge={device} />}
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
// here, so it stays out of the row's label and hover tip.
function EntryName({ worktree }: { worktree: Worktree }) {
  const resident = useResident(worktree);
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
      <span className="min-w-0 truncate">{worktree.name}</span>
      <BirthdayBadge resident={resident} />
    </>
  );
}
