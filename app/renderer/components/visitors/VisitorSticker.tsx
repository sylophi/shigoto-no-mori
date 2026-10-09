import { type CSSProperties, useState } from "react";
import { Heart } from "lucide-react";
import { VillagerFaceView } from "@/components/shared/VillagerSaysView";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { StationeryPrint } from "@/components/villagers/StationeryPrint";
import { FaceStamp } from "@/components/villagers/VillagerLetter";
import {
  Nameplate,
  villagerInk,
} from "@/components/villagers/VillagerDialogue";
import { useFaceColor } from "@/hooks/villagers/useFaceColor";
import { useVillagerFace } from "@/hooks/villagers/useVillagers";
import { useSeen } from "@/hooks/ui/useSeen";
import { useNow } from "@/hooks/ui/useNow";
import { useToday } from "@/hooks/ui/useToday";
import { formatRelativeTime } from "@/lib/relativeTime";
import { cn } from "@/lib/utils";
import { villagerCatchphrase, villagerSpecies } from "@/lib/villagerVoice";
import { birthdayLabel } from "@/lib/villagers/birthdays";
import { stationeryFor } from "@/lib/villagers/stationery";
import {
  type AlbumEntry,
  isNewVisitor,
  stickerTilt,
  visitDate,
  visitedTimes,
  type Visits,
} from "@/lib/villagers/visitors";

// One slot in the Visitors album. A villager who has visited is a
// sticker stuck in at a slight lean: their face, their name and how
// often they have come. Pressed, it flips over to their card, which
// says what kind of villager they are.
// One who hasn't is an empty slot holding their silhouette. The rarer
// the character, the more the sticker carries (DESIGN.md, "Village
// life: rarity"): a regular villager's is plain, a special character's
// washes in their own color under their name plate, and a legend's is
// printed on their stationery with their face on a stamp.

// Every slot is one size, so the album lines up and a flip keeps its
// place, in a grid of as many as fit.
export const ALBUM_SLOT = "h-40";
export const ALBUM_GRID =
  "grid grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-3";

// The first few pop in one after another. Past these they all come at
// once: nobody waits on the five-hundredth.
const STAGGERED = 24;

export function VisitorSlot({
  entry,
  index,
  bestFriend,
}: {
  entry: AlbumEntry;
  index: number;
  // The one villager met most (Album.bestFriend), whose sticker says so.
  bestFriend: boolean;
}) {
  // A face loads once its slot is scrolled near.
  const [ref, seen] = useSeen<HTMLDivElement>();
  const face = useVillagerFace(seen ? entry.slug : null);
  // The pop is on the slot and not the sticker: doubutsu takes over a
  // button's animation while it is hovered or pressed, and handing it
  // back would play the pop again. The slot is what's hovered too,
  // since it stays put while the sticker lifts out from under the
  // pointer.
  return (
    <div
      ref={ref}
      style={{ animationDelay: `${Math.min(index, STAGGERED) * 30}ms` }}
      className={`visitor-pop group/sticker ${ALBUM_SLOT}`}
    >
      {entry.visits === null ? (
        <EmptySlot entry={entry} face={face} />
      ) : (
        <Sticker
          entry={entry}
          visits={entry.visits}
          face={face}
          bestFriend={bestFriend}
        />
      )}
    </div>
  );
}

function Sticker({
  entry,
  visits,
  face,
  bestFriend,
}: {
  entry: AlbumEntry;
  visits: Visits;
  face: string | null;
  bestFriend: boolean;
}) {
  const [flipped, setFlipped] = useState(false);
  // The back is drawn from the first flip on: most cards never turn.
  const [turned, setTurned] = useState(false);
  const { profile } = entry;
  const flip = () => {
    setFlipped((was) => !was);
    setTurned(true);
  };
  return (
    <button
      type="button"
      data-slot="visitor-sticker-button"
      aria-pressed={flipped}
      aria-label={`${profile.name}${bestFriend ? ", your best friend" : ""}, visited ${visitedTimes(visits.count)}`}
      onClick={flip}
      style={{ "--tilt": `${stickerTilt(entry.slug)}deg` } as CSSProperties}
      className={cn(
        "relative block size-full rounded-2xl text-left [perspective:900px] transition-[rotate,translate] duration-300 ease-out [rotate:var(--tilt)] focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
        "group-hover/sticker:-translate-y-1 group-hover/sticker:[rotate:0deg]",
        flipped && "[rotate:0deg]",
      )}
    >
      <span
        className={cn(
          "relative block size-full transition-transform duration-500 ease-[cubic-bezier(0.3,1.3,0.5,1)] [transform-style:preserve-3d]",
          flipped && "[transform:rotateY(180deg)]",
        )}
      >
        <StickerFront
          entry={entry}
          visits={visits}
          face={face}
          bestFriend={bestFriend}
        />
        {turned && <StickerBack entry={entry} visits={visits} face={face} />}
      </span>
    </button>
  );
}

const FACE_SIDE =
  "absolute inset-0 flex flex-col items-center overflow-hidden rounded-2xl [backface-visibility:hidden]";

function StickerFront({
  entry,
  visits,
  face,
  bestFriend,
}: {
  entry: AlbumEntry;
  visits: Visits;
  face: string | null;
  bestFriend: boolean;
}) {
  const { slug, profile, rarity } = entry;
  const color = useFaceColor(rarity === "rare" ? face : null);
  const paper = stationeryFor(slug);
  const today = useToday();
  return (
    <span
      data-slot="visitor-sticker"
      style={villagerInk(color)}
      className={cn(FACE_SIDE, "bg-card px-2.5 pt-7 pb-3 shadow-sm")}
    >
      {rarity === "legendary" && (
        <StationeryPrint paper={paper} className="opacity-20" />
      )}
      {rarity === "rare" && (
        <span
          aria-hidden
          className="absolute inset-x-0 top-0 h-[58%] bg-(--villager-ink) opacity-15"
        />
      )}
      {bestFriend ? (
        <span className="absolute top-2 left-2 flex -rotate-6 items-center gap-1 rounded-md bg-rose-500 px-1.5 py-0.5 text-3xs font-bold text-white">
          <Heart aria-hidden className="size-2.5 fill-current" />
          Best friend
        </span>
      ) : (
        isNewVisitor(visits, today.getTime()) && (
          <span className="absolute top-2 left-2 -rotate-6 rounded-md bg-emerald-500 px-1.5 py-0.5 text-3xs font-bold text-white">
            New!
          </span>
        )
      )}
      <span className="relative flex size-16 items-center justify-center">
        {face !== null &&
          (rarity === "legendary" ? (
            <FaceStamp
              face={face}
              tint={paper.color}
              className="size-full rotate-3 bg-popover transition-transform duration-300 group-hover/sticker:rotate-0"
            />
          ) : (
            <VillagerFaceView
              face={face}
              className="size-full transition-transform duration-300 group-hover/sticker:scale-110 group-hover/sticker:-rotate-6"
            />
          ))}
      </span>
      <span className="relative mt-2 flex h-5 max-w-full items-center">
        {rarity === "rare" ? (
          <Nameplate className="truncate px-2 text-xs">
            {profile.name}
          </Nameplate>
        ) : (
          <span
            className={cn(
              "truncate text-sm font-bold",
              rarity === "legendary" && paper.ink,
            )}
          >
            {profile.name}
          </span>
        )}
      </span>
      <span className="relative mt-auto text-2xs font-medium text-muted-foreground">
        Visited {visitedTimes(visits.count)}
      </span>
    </span>
  );
}

// The back of the card: what the guest book knows of them, written on
// lined paper. How often they came is on the front.
function StickerBack({
  entry,
  visits,
  face,
}: {
  entry: AlbumEntry;
  visits: Visits;
  face: string | null;
}) {
  const { slug, profile, rarity } = entry;
  const now = useNow();
  const ink = rarity === "legendary" ? stationeryFor(slug).ink : "";
  const catchphrase = villagerCatchphrase(profile);
  const birthday = birthdayLabel(profile.birthday);
  // Label, value. A special character has a species and no personality,
  // and a legend may have neither: a row the profile leaves out goes.
  const rows: [string, string | null | undefined][] = [
    ["Personality", profile.personality],
    ["Species", villagerSpecies(profile)],
    ["Birthday", birthday],
    ["First visit", visitDate(visits.first)],
    ["Last visit", formatRelativeTime(visits.last, now)],
  ];
  const filled = rows.filter((row): row is [string, string] => !!row[1]);
  return (
    <span
      data-slot="visitor-sticker"
      className={cn(
        FACE_SIDE,
        "items-stretch bg-popover px-2.5 py-2 shadow-sm [transform:rotateY(180deg)]",
      )}
    >
      <span className="flex items-center gap-2">
        {face !== null && <VillagerFaceView face={face} className="size-5" />}
        <span className={cn("min-w-0 truncate text-xs font-bold", ink)}>
          {profile.name}
        </span>
      </span>
      <span className="mt-1.5 flex flex-col bg-[linear-gradient(transparent_calc(100%-1px),color-mix(in_oklab,var(--color-amber-400)_40%,transparent)_0)] bg-size-[100%_1.125rem] text-2xs leading-[1.125rem]">
        {filled.map(([label, value]) => (
          <span key={label} className="flex justify-between gap-2">
            <span className="shrink-0 text-muted-foreground">{label}</span>
            <SimpleTooltip whenTruncated tip={value}>
              <span className="min-w-0 truncate font-medium">{value}</span>
            </SimpleTooltip>
          </span>
        ))}
      </span>
      {catchphrase !== null && (
        <span className="mt-auto truncate pt-0.5 text-center text-2xs font-medium text-muted-foreground italic">
          “{catchphrase}”
        </span>
      )}
    </span>
  );
}

// A slot nobody has filled yet: their silhouette and a question mark,
// and for a regular villager what kind of animal they are, for a hint.
function EmptySlot({
  entry,
  face,
}: {
  entry: AlbumEntry;
  face: string | null;
}) {
  const hint =
    entry.rarity === "common" ? villagerSpecies(entry.profile) : undefined;
  return (
    <div
      aria-label="Hasn't visited yet"
      role="img"
      className="relative flex size-full flex-col items-center justify-center rounded-2xl bg-muted/60 px-3"
    >
      <span className="flex size-14 items-center justify-center">
        {face !== null && (
          <VillagerFaceView
            face={face}
            tint={false}
            className="size-12 opacity-15 brightness-0 dark:opacity-25 dark:invert"
          />
        )}
      </span>
      <span className="mt-2 text-sm font-black tracking-widest text-muted-foreground/60">
        ???
      </span>
      {hint && (
        <span className="mt-0.5 text-2xs text-muted-foreground/70">{hint}</span>
      )}
    </div>
  );
}
