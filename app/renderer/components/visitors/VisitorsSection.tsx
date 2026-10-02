import { useState } from "react";
import { VillagerFace } from "@/components/shared/VillagerSays";
import { DialogueFrame } from "@/components/villagers/VillagerDialogue";
import { TypedWords } from "@/components/villagers/TypedWords";
import { ChipButton } from "@/components/ui/chip-button";
import { SectionHeading } from "@/components/ui/section-heading";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useVillagerFace,
  useVillagerProfiles,
} from "@/hooks/villagers/useVillagers";
import { useVisitors } from "@/hooks/villagers/useVisitors";
import { cn } from "@/lib/utils";
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
  const [everyone, setEveryone] = useState(false);

  if (profiles === undefined) return <AlbumSkeleton />;
  const album = buildAlbum(profiles, visits);
  return (
    <div className="flex flex-col gap-8">
      {album.visited.length === 0 ? <NobodyYet /> : <GuestBook album={album} />}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SegmentedControl
          aria-label="Sort"
          value={sort}
          onChange={setSort}
          options={SORT_OPTIONS}
          optionClassName="px-2.5 py-1 text-xs"
        />
        <ChipButton
          aria-pressed={everyone}
          onClick={() => setEveryone(!everyone)}
        >
          {everyone ? "Hide who hasn't visited" : "Show who hasn't visited"}
        </ChipButton>
      </div>
      {SECTIONS.map(({ rarity, title, allSlots }) => (
        <AlbumSection
          key={rarity}
          title={title}
          entries={sortAlbum(album.sections[rarity], sort)}
          met={album.met[rarity]}
          allSlots={allSlots || everyone}
          bestFriend={album.bestFriend?.slug ?? null}
          onShowEveryone={() => setEveryone(true)}
        />
      ))}
    </div>
  );
}

function AlbumSection({
  title,
  entries,
  met,
  allSlots,
  bestFriend,
  onShowEveryone,
}: {
  title: string;
  // Visited first (sortAlbum), `met` of them.
  entries: AlbumEntry[];
  met: number;
  allSlots: boolean;
  bestFriend: string | null;
  onShowEveryone: () => void;
}) {
  if (entries.length === 0) return null;
  const shown = allSlots ? entries : entries.slice(0, met);
  const hidden = entries.length - shown.length;
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
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
        {hidden > 0 && (
          <button
            type="button"
            onClick={onShowEveryone}
            className={cn(
              ALBUM_SLOT,
              "flex flex-col items-center justify-center gap-1 rounded-2xl bg-muted/60 px-3 text-center text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
            )}
          >
            <span className="text-2xl font-black tabular-nums">+{hidden}</span>
            <span className="text-xs font-medium">still to meet</span>
          </button>
        )}
      </div>
    </section>
  );
}

// An empty guest book: Isabelle explains, in her dialogue box.
const NOBODY_YET =
  "Nobody has signed the guest book yet! Make a worktree named after a villager, and they'll come by to visit.";

function NobodyYet() {
  const face = useVillagerFace("isabelle");
  return (
    <DialogueFrame name="Isabelle" color={null} className="max-w-xl">
      {face !== null && (
        <VillagerFace face={face} className="size-12 shrink-0" />
      )}
      <p className="min-w-0 flex-1 text-[15px] leading-snug font-medium">
        <TypedWords words={NOBODY_YET} />
      </p>
    </DialogueFrame>
  );
}

function AlbumSkeleton() {
  return (
    <div className="flex flex-col gap-8">
      <Skeleton className="h-56 rounded-[22px]" />
      <div className={ALBUM_GRID}>
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className={cn(ALBUM_SLOT, "rounded-2xl")} />
        ))}
      </div>
    </div>
  );
}
