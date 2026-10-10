import { useState } from "react";
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
import { resetVisits } from "@/lib/villagers/visitLog";
import {
  buildAlbum,
  sortAlbum,
  type VisitorSort,
} from "@shigomori/ui/lib/villagers/visitors.ts";
import type { VillagerRarity } from "@shigomori/ui/lib/villagers/rarity.ts";
import { GuestBook } from "./GuestBook";
import { VisitorSlot } from "./VisitorSlot";
import {
  AlbumSectionView,
  AlbumSkeletonView,
  NobodyYetView,
  StartOverView,
  VisitorsSectionView,
} from "@shigomori/ui/views/visitors/VisitorsSectionView.tsx";

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

// The album of who has visited (VisitorsSectionView), built from the
// villager data and this app's visit log.
export function VisitorsSection() {
  const profiles = useVillagerProfiles();
  const visits = useVisitors();
  const [sort, setSort] = useState<VisitorSort>("visits");
  // The sections showing who hasn't visited too. Each opens and folds
  // on its own, the chip above does all of them.
  const [open, setOpen] = useState<ReadonlySet<VillagerRarity>>(new Set());

  if (profiles === undefined) return <AlbumSkeletonView />;
  const album = buildAlbum(profiles, visits);
  // The sections that fold: not every slot shows, and someone is left
  // to meet.
  const folding = SECTIONS.filter(
    ({ rarity, allSlots }) =>
      !allSlots && album.met[rarity] < album.sections[rarity].length,
  ).map(({ rarity }) => rarity);
  const everyone = folding.every((rarity) => open.has(rarity));
  return (
    <VisitorsSectionView
      metTotal={album.metTotal}
      guestBook={
        album.metTotal === 0 ? <NobodyYet /> : <GuestBook album={album} />
      }
      sort={sort}
      onSort={setSort}
      folding={folding.length > 0}
      everyone={everyone}
      onToggleEveryone={() => setOpen(new Set(everyone ? [] : folding))}
      sections={SECTIONS.map(({ rarity, title }) => {
        const entries = sortAlbum(album.sections[rarity], sort);
        const met = album.met[rarity];
        // Whether who hasn't visited shows too, or null in a section
        // that doesn't fold (every slot shows).
        const unfolded = folding.includes(rarity) ? open.has(rarity) : null;
        const shown = unfolded === false ? entries.slice(0, met) : entries;
        return (
          <AlbumSectionView
            key={rarity}
            title={title}
            total={entries.length}
            met={met}
            open={unfolded}
            onOpen={(show) => setOpen((was) => withMember(was, rarity, show))}
            slots={shown.map((entry, index) => (
              <VisitorSlot
                key={entry.slug}
                entry={entry}
                index={index}
                bestFriend={entry.slug === album.bestFriend?.slug}
              />
            ))}
          />
        );
      })}
      startOver={<StartOver />}
    />
  );
}

// Clearing the guest book takes a second click: the visits can't be
// counted again.
function StartOver() {
  const confirm = useConfirmTwice(CONFIRM_DESTRUCTIVE_MS);
  return (
    <StartOverView
      armed={confirm.armed}
      onReset={() => confirm.trigger(resetVisits)}
    />
  );
}

function NobodyYet() {
  return <NobodyYetView face={useVillagerFace("isabelle")} />;
}
