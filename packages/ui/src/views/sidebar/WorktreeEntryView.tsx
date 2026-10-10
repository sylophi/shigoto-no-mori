import type { ComponentProps, ReactNode } from "react";
import { cn } from "../../lib/utils.ts";
import { worktreeTitle } from "../../lib/worktreeTitle.ts";
import { BranchLabel } from "../../primitives/branch-label.tsx";
import { SimpleTooltip } from "../../primitives/tooltip.tsx";
import { VillagerFaceView } from "../shared/VillagerSaysView.tsx";
import { WorktreeKindIconView } from "../shared/WorktreeKindIconView.tsx";
import { BirthdayBadgeView } from "../villagers/BirthdayBadgeView.tsx";
import type { Resident } from "../../lib/villagerVoice.ts";
import type { StackPosition } from "@shigomori/contracts/pullRequestStack";
import type { PullRequest, Worktree } from "@shigomori/contracts/schemas/index";
import { ActivityIconView } from "./ActivityIconView.tsx";
import { AgentWaitingMarkView } from "./AgentWaitingMarkView.tsx";
import {
  DeviceBadgeView,
  MirrorBadgeView,
  type SidebarDeviceBadge,
} from "./DeviceBadgeView.tsx";
import { ForwardMarkView } from "./ForwardMarkView.tsx";
import { PullRequestPillView } from "./PullRequestPillView.tsx";
import type { InboxShelf } from "./sidebarRow.ts";
import {
  ChangedFilesPillView,
  RemoteSyncPillView,
} from "./StatusIndicatorView.tsx";
import { activityMark, type WorktreeRowLook } from "./rowLook.ts";

// The marks this window's sidebar rows wear (Settings, Appearance), in
// one read, for the containers that hand them to the rows' views.
export interface SidebarMarks {
  // Terrier's paw on a terrier-sourced project.
  terrier: boolean;
  // A peer's badge on its rows and project headers.
  deviceBadges: boolean;
  // An agent waiting on you, on its worktree's row.
  agentsWaiting: boolean;
  // Agent-working worktrees filed on their own shelf.
  allowAgentWorking: boolean;
}

export interface WorktreeEntry {
  look: WorktreeRowLook;
  open: () => void;
  // The villager whose home the worktree is, under Village life.
  resident: Resident | null;
  // This machine's forwards of a peer's worktree, for its mark.
  forwardTip: string | undefined;
  marks: SidebarMarks;
}

interface WorktreeEntryProps extends ComponentProps<"button"> {
  worktree: Worktree;
  pr: PullRequest | undefined;
  stack: StackPosition | null;
  // The PR pill's hidePosition, for a row on a whole stack rail.
  hideStackPosition?: boolean;
  // The peer the worktree lives on, absent for this machine's own, and
  // the peer a local one is mirrored with.
  device: SidebarDeviceBadge | undefined;
  mirror: SidebarDeviceBadge | undefined;
  look: WorktreeRowLook;
  onOpen: () => void;
  // The villager whose home it is, and this machine's forwards of a
  // peer's worktree (useWorktreeEntry).
  resident: Resident | null;
  forwardTip: string | undefined;
  marks: SidebarMarks;
  // The fold or shelf the row was filed behind (sidebarRow), null for
  // the open rows.
  shelf: InboxShelf | null;
  // The inbox's line over the branch, naming the project and when the
  // worktree last moved, with the device marks and what's running.
  // Absent (the tree, which shows one project at a time), those marks
  // fold into the two lines below.
  context?: ReactNode;
}

// A worktree in the sidebar, the tree's row (WorktreeRowView) and the
// inbox's (InboxRowView) alike: what the work is called (its PR's title,
// or the one `sm describe` gave it, else the branch) across the row's
// full width, over the worktree's own name and every status pill.
//
//   [icon] project                                  14m ago   (inbox)
//   Name the work before the PR, at full width
//   [kind] dirname [device]                    ±3  ↑2  #142
//
// Without a context line, a running script's mark leads the pills, and
// a delete in flight takes their place: the worktree is going away, so
// the trash standing alone reads as "destroying". Children lead the
// button (the tree's stack rail). Props pass through to the
// button, so a menu trigger can render it as its own element.
export function WorktreeEntryView({
  worktree,
  pr,
  stack,
  hideStackPosition,
  device,
  mirror,
  look,
  onOpen,
  resident,
  forwardTip,
  marks,
  shelf,
  context,
  className,
  children,
  onClick,
  ...button
}: WorktreeEntryProps) {
  const { isSelected, isDeleting } = look;
  // The tree's row, which has no context line to carry these marks.
  const inline = context === undefined;
  const mark = inline ? activityMark(look) : null;
  const title = worktreeTitle(worktree, pr);
  return (
    <button
      type="button"
      {...button}
      onClick={(event) => {
        onClick?.(event);
        onOpen();
      }}
      className={cn(
        "relative flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors",
        // data-popup-open is Base UI's mark on a trigger whose menu is
        // up (the inbox row's): keep the row lit so it's clear whose
        // menu this is.
        "hover:bg-accent/60 focus-visible:outline-2 focus-visible:outline-ring data-popup-open:bg-accent/60",
        isSelected && "bg-accent text-accent-foreground",
        // One fade, the strongest that applies: a delete in flight, then
        // an unreachable device's last known state, then a row filed
        // away: agent working, shelved or behind a hidden prefix. Merged
        // is git's call, not theirs, so it keeps full strength.
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
      {/* Weight is reserved for "this is the one you have open".
          Bolding every title spends the page's only emphasis on the
          thing every row has. */}
      <SimpleTooltip whenTruncated tip={title ?? worktree.branch}>
        <span
          className={cn(
            "truncate text-xs",
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
      {/* The worktree's own name gets a line to itself rather than
          sharing one with the project: they're both "where is this",
          and side by side the longer one just eats the other. The
          pills ride at its end, leaving the title the full width, and
          wrap under the name rather than squeeze it below its floor. */}
      <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-3xs text-muted-foreground/70">
        {/* No min-w-0: the group's least width is the name's floor
            (EntryName) plus its marks, and that is what the line
            wraps the pills at. */}
        <span className="flex flex-1 items-center gap-1">
          <EntryName
            worktree={worktree}
            resident={resident}
            allowAgentWorking={marks.allowAgentWorking}
          />
          {/* Pulled in vertically: the device tile stands taller than
              the line, and letting it set the line's height would make
              a peer's row taller than a local one. The forward mark
              rides here on either row: it is about this worktree, not
              where it lives, which the inbox's context line says. */}
          <span className="-my-1 inline-flex shrink-0 items-center gap-1">
            {forwardTip !== undefined && <ForwardMarkView tip={forwardTip} />}
            {inline && mirror && (
              <MirrorBadgeView mirror={mirror} showBadge={marks.deviceBadges} />
            )}
            {inline && device && marks.deviceBadges && (
              <DeviceBadgeView badge={device} />
            )}
          </span>
        </span>
        <span className="ml-auto inline-flex shrink-0 items-center gap-1.5 empty:hidden">
          {marks.agentsWaiting && <AgentWaitingMarkView worktree={worktree} />}
          {mark && <ActivityIconView kind={mark} />}
          {!(inline && isDeleting) && (
            <>
              <ChangedFilesPillView worktree={worktree} />
              <RemoteSyncPillView worktree={worktree} />
              <PullRequestPillView
                pr={pr}
                stack={stack}
                hidePosition={hideStackPosition}
              />
            </>
          )}
        </span>
      </span>
    </button>
  );
}

// The worktree's own name, led by its kind glyph when it's the primary
// or external. A shelf kind (agent working, shelved) would restate the
// shelf the row already sits under. The primary's house glyph stays, since it's what tells the
// root apart from a worktree named after the project. Under Village
// life, the villager whose home this is sits beside the name, as their
// face sits beside the title on the worktree page. It's decoration
// here, so it stays out of the row's label.
function EntryName({
  worktree,
  resident,
  allowAgentWorking,
}: {
  worktree: Worktree;
  resident: Resident | null;
  allowAgentWorking: boolean;
}) {
  return (
    <>
      {(worktree.isPrimary || worktree.isExternal) && (
        <WorktreeKindIconView
          worktree={worktree}
          allowAgentWorking={allowAgentWorking}
        />
      )}
      {resident?.face && (
        <VillagerFaceView
          face={resident.face}
          tint={false}
          className="-my-0.5 size-3.5"
        />
      )}
      {/* w-8 is the floor the line wraps its pills at. */}
      <SimpleTooltip whenTruncated tip={worktree.name}>
        <span className="w-8 max-w-fit grow truncate">{worktree.name}</span>
      </SimpleTooltip>
      <BirthdayBadgeView resident={resident} />
    </>
  );
}
