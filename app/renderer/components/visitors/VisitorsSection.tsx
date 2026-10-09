import { useRef, useState } from "react";
import { FoldVertical, RotateCcw } from "lucide-react";
import { VillagerFaceView } from "@/components/shared/VillagerSaysView";
import { DialogueFrame } from "@/components/villagers/VillagerDialogue";
import { TypedWords } from "@/components/villagers/TypedWords";
import { ChipButton } from "@/components/ui/chip-button";
import { ConfirmDestructiveButton } from "@/components/ui/confirm-destructive-button";
import { SectionHeading, SectionIntro } from "@/components/ui/section-heading";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useVillagerFace,
  useVillagerProfiles,
} from "@/hooks/villagers/useVillagers";
import { useVisitors } from "@/hooks/villagers/useVisitors";
import {
  CONFIRM_DESTRUCTIVE_MS,
  useConfirmTwice,
} from "@/hooks/ui/useConfirmTwice";
import { withMember } from "@/lib/toggleSet";
import { cn } from "@/lib/utils";
import { resetVisits } from "@/lib/villagers/visitLog";
import {
  type AlbumEntry,
  buildAlbum,
  sortAlbum,
  type VisitorSort,
} from "@/lib/villagers/visitors";
import type { VillagerRarity } from "@shared/villagers/rarity";
import { AlbumProgress } from "./AlbumProgress";
import { GuestBook } from "./GuestBook";
import { ALBUM_GRID, ALBUM_SLOT, VisitorSlot } from "./VisitorSticker";

const SORT_OPTIONS = [
  { value: "visits", label: "Most visits" },
  { value: "recent", label: "Recent" },
  { value: "name", label: "Name" },
] as const satisfies readonly { value: VisitorSort; label: string }[];

const SECTIONS: {
  rarity: VillagerRarity;
  title: string;
  // Every slot shows, filled or not: few enough to chase.
  allSlots: boolean;
}[] = [
  { rarity: "legendary", title: "Legends", allSlots: true },
  { rarity: "rare", title: "Special guests", allSlots: false },
  { rarity: "common", title: "Villagers", allSlots: false },
];

// Who has visited: every villager whose home a worktree has been, on
// any device this app shows, collected like stickers in an album
// (lib/villagers/visitLog.ts, kept by this app alone). A section of
// Settings while the window's Village life shows (settingsNav.ts): it
// needs the villager data for the faces.
export function VisitorsSection() {
  const profiles = useVillagerProfiles();
  const visits = useVisitors();
  const [sort, setSort] = useState<VisitorSort>("visits");
  // The sections showing who hasn't visited too. Each opens and folds
  // on its own, the chip above does all of them.
  const [open, setOpen] = useState<ReadonlySet<VillagerRarity>>(new Set());

  if (profiles === undefined) return <AlbumSkeleton />;
  const album = buildAlbum(profiles, visits);
  // The sections that fold: not every slot shows, and someone is left
  // to meet.
  const folding = SECTIONS.filter(
    ({ rarity, allSlots }) =>
      !allSlots && album.met[rarity] < album.sections[rarity].length,
  ).map(({ rarity }) => rarity);
  const everyone = folding.every((rarity) => open.has(rarity));
  return (
    <div className="flex flex-col gap-8">
      {album.metTotal === 0 ? <NobodyYet /> : <GuestBook album={album} />}
      {(album.metTotal > 0 || folding.length > 0) && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          {/* Only who has visited is sorted: the rest go by name. */}
          {album.metTotal > 0 && (
            <SegmentedControl
              aria-label="Sort"
              value={sort}
              onChange={setSort}
              options={SORT_OPTIONS}
              optionClassName="px-2.5 py-1 text-xs"
            />
          )}
          {folding.length > 0 && (
            <ChipButton
              aria-pressed={everyone}
              onClick={() => setOpen(new Set(everyone ? [] : folding))}
              className="ml-auto"
            >
              {everyone ? "Hide who hasn't visited" : "Show who hasn't visited"}
            </ChipButton>
          )}
        </div>
      )}
      {SECTIONS.map(({ rarity, title }) => (
        <AlbumSection
          key={rarity}
          title={title}
          entries={sortAlbum(album.sections[rarity], sort)}
          met={album.met[rarity]}
          open={folding.includes(rarity) ? open.has(rarity) : null}
          onOpen={(show) => setOpen((was) => withMember(was, rarity, show))}
          bestFriend={album.bestFriend?.slug ?? null}
        />
      ))}
      {album.metTotal > 0 && <StartOver />}
    </div>
  );
}

// Clearing the guest book takes a second click: the visits can't be
// counted again.
function StartOver() {
  const confirm = useConfirmTwice(CONFIRM_DESTRUCTIVE_MS);
  return (
    <SectionIntro
      title="Start over"
      action={
        <ConfirmDestructiveButton
          armed={confirm.armed}
          pending={false}
          pendingLabel=""
          idleLabel="Reset the guest book"
          icon={<RotateCcw aria-hidden className="size-3.5" />}
          onClick={() => confirm.trigger(resetVisits)}
        />
      }
    >
      Clears every visit. Villagers living here now won't sign again, only the
      ones who move in next.
    </SectionIntro>
  );
}

function AlbumSection({
  title,
  entries,
  met,
  open,
  onOpen,
  bestFriend,
}: {
  title: string;
  // Visited first (sortAlbum), `met` of them.
  entries: AlbumEntry[];
  met: number;
  // Whether who hasn't visited shows too, or null in a section that
  // doesn't fold (every slot shows).
  open: boolean | null;
  onOpen: (open: boolean) => void;
  bestFriend: string | null;
}) {
  const heading = useRef<HTMLDivElement>(null);
  if (entries.length === 0) return null;
  const unmet = entries.length - met;
  const shown = open === false ? entries.slice(0, met) : entries;
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
          {met} of {entries.length}
        </span>
        <AlbumProgress
          met={met}
          total={entries.length}
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
        {shown.map((entry, index) => (
          <VisitorSlot
            key={entry.slug}
            entry={entry}
            index={index}
            bestFriend={entry.slug === bestFriend}
          />
        ))}
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
      /auto|scroll/.test(getComputedStyle(pane).overflowY)
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

function NobodyYet() {
  const face = useVillagerFace("isabelle");
  return (
    <DialogueFrame name="Isabelle" color={null} className="max-w-xl">
      {face !== null && (
        <VillagerFaceView face={face} className="size-10 shrink-0" />
      )}
      <p className="min-w-0 flex-1 text-sm leading-snug font-medium">
        <TypedWords words={NOBODY_YET} />
      </p>
    </DialogueFrame>
  );
}

function AlbumSkeleton() {
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
