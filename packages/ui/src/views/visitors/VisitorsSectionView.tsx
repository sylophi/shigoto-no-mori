import { type ReactNode, useRef } from "react";
import { FoldVertical, RotateCcw } from "lucide-react";
import { VillagerFaceView } from "../shared/VillagerSaysView.tsx";
import { DialogueFrameView } from "../villagers/VillagerDialogueView.tsx";
import { TypedWordsView } from "../villagers/TypedWordsView.tsx";
import { ChipButton } from "../../primitives/chip-button.tsx";
import { ConfirmDestructiveButton } from "../../primitives/confirm-destructive-button.tsx";
import {
  SectionHeading,
  SectionIntro,
} from "../../primitives/section-heading.tsx";
import { SegmentedControl } from "../../primitives/segmented-control.tsx";
import { Skeleton } from "../../primitives/skeleton.tsx";
import { cn } from "../../lib/utils.ts";
import type { VisitorSort } from "../../lib/villagers/visitors.ts";
import { AlbumProgressView } from "./AlbumProgressView.tsx";
import { ALBUM_GRID, ALBUM_SLOT } from "./VisitorStickerView.tsx";

const SORT_OPTIONS = [
  { value: "visits", label: "Most visits" },
  { value: "recent", label: "Recent" },
  { value: "name", label: "Name" },
] as const satisfies readonly { value: VisitorSort; label: string }[];

// Who has visited: every villager whose home a worktree has been, on
// any device this app shows, collected like stickers in an album
// (lib/villagers/visitLog.ts, kept by this app alone). A section of
// Settings while the window's Village life shows (settingsNav.ts): it
// needs the villager data for the faces.
export function VisitorsSectionView({
  metTotal,
  guestBook,
  sort,
  onSort,
  folding,
  everyone,
  onToggleEveryone,
  sections,
  startOver,
}: {
  // How many have visited, in every section.
  metTotal: number;
  // The guest book (GuestBook), or Isabelle when nobody has signed it.
  guestBook: ReactNode;
  sort: VisitorSort;
  onSort: (sort: VisitorSort) => void;
  // Some section folds: not every slot shows, and someone is left to
  // meet.
  folding: boolean;
  // Every folding section shows who hasn't visited.
  everyone: boolean;
  onToggleEveryone: () => void;
  // The album's sections (AlbumSectionView).
  sections: ReactNode;
  startOver: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-8">
      {guestBook}
      {(metTotal > 0 || folding) && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          {/* Only who has visited is sorted: the rest go by name. */}
          {metTotal > 0 && (
            <SegmentedControl
              aria-label="Sort"
              value={sort}
              onChange={onSort}
              options={SORT_OPTIONS}
              optionClassName="px-2.5 py-1 text-xs"
            />
          )}
          {folding && (
            <ChipButton
              aria-pressed={everyone}
              onClick={onToggleEveryone}
              className="ml-auto"
            >
              {everyone ? "Hide who hasn't visited" : "Show who hasn't visited"}
            </ChipButton>
          )}
        </div>
      )}
      {sections}
      {metTotal > 0 && startOver}
    </div>
  );
}

// Clearing the guest book takes a second click: the visits can't be
// counted again.
export function StartOverView({
  armed,
  onReset,
}: {
  armed: boolean;
  onReset: () => void;
}) {
  return (
    <SectionIntro
      title="Start over"
      action={
        <ConfirmDestructiveButton
          armed={armed}
          pending={false}
          pendingLabel=""
          idleLabel="Reset the guest book"
          icon={<RotateCcw aria-hidden className="size-3.5" />}
          onClick={onReset}
        />
      }
    >
      Clears every visit. Villagers living here now won't sign again, only the
      ones who move in next.
    </SectionIntro>
  );
}

export function AlbumSectionView({
  title,
  total,
  met,
  open,
  onOpen,
  slots,
}: {
  title: string;
  // How many the section holds, `met` of them visited.
  total: number;
  met: number;
  // Whether who hasn't visited shows too, or null in a section that
  // doesn't fold (every slot shows).
  open: boolean | null;
  onOpen: (open: boolean) => void;
  // The slots showing (VisitorSlot): visited first (sortAlbum), and
  // folded, those alone.
  slots: ReactNode[];
}) {
  const heading = useRef<HTMLDivElement>(null);
  if (total === 0) return null;
  const unmet = total - met;
  // Folded from the foot of a long section, the page would be left
  // somewhere past it: bring its heading back into view.
  const fold = () => {
    onOpen(false);
    requestAnimationFrame(() => {
      if (heading.current) revealAbove(heading.current);
    });
  };
  return (
    <section className="flex flex-col gap-3">
      <div ref={heading} className="flex items-center gap-3">
        <SectionHeading>{title}</SectionHeading>
        <span className="text-xs font-medium text-muted-foreground tabular-nums">
          {met} of {total}
        </span>
        <AlbumProgressView
          met={met}
          total={total}
          label={`${title} met`}
          className="h-1.5 max-w-40 flex-1"
        />
        {open === true && (
          <ChipButton className="ml-auto" onClick={fold}>
            <FoldVertical aria-hidden className="size-3.5" />
            Fold away
          </ChipButton>
        )}
      </div>
      <div className={ALBUM_GRID}>
        {slots}
        {open !== null && (
          <button
            type="button"
            aria-expanded={open}
            onClick={open ? fold : () => onOpen(true)}
            className={cn(
              ALBUM_SLOT,
              "flex flex-col items-center justify-center gap-1 rounded-2xl bg-muted/60 px-3 text-center text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
            )}
          >
            {open ? (
              <>
                <FoldVertical aria-hidden className="size-6" />
                <span className="text-xs font-medium">Fold away</span>
              </>
            ) : (
              <>
                <span className="text-lg font-black tabular-nums">
                  +{unmet}
                </span>
                <span className="text-xs font-medium">still to meet</span>
              </>
            )}
          </button>
        )}
      </div>
    </section>
  );
}

// Scrolls the nearest ancestor that scrolls alone (not scrollIntoView,
// which would pull every one, the settings page's own frame too) until
// `element` is no longer above its top.
function revealAbove(element: HTMLElement) {
  let pane = element.parentElement;
  while (
    pane &&
    !(
      pane.scrollHeight > pane.clientHeight &&
      /auto|scroll/.test(
        pane.ownerDocument.defaultView?.getComputedStyle(pane).overflowY ?? "",
      )
    )
  ) {
    pane = pane.parentElement;
  }
  if (!pane) return;
  const gap = element.getBoundingClientRect().top - 16;
  const top = pane.getBoundingClientRect().top;
  if (gap < top) pane.scrollTop -= top - gap;
}

// An empty guest book: Isabelle explains, in her dialogue box.
const NOBODY_YET =
  "Nobody has signed the guest book yet! Make a worktree named after a villager, and they'll come by to visit.";

export function NobodyYetView({ face }: { face: string | null }) {
  return (
    <DialogueFrameView name="Isabelle" color={null} className="max-w-xl">
      {face !== null && (
        <VillagerFaceView face={face} className="size-10 shrink-0" />
      )}
      <p className="min-w-0 flex-1 text-sm leading-snug font-medium">
        <TypedWordsView words={NOBODY_YET} />
      </p>
    </DialogueFrameView>
  );
}

export function AlbumSkeletonView() {
  return (
    <div className="flex flex-col gap-8">
      <Skeleton className="h-52 rounded-[22px]" />
      <div className={ALBUM_GRID}>
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className={cn(ALBUM_SLOT, "rounded-2xl")} />
        ))}
      </div>
    </div>
  );
}
