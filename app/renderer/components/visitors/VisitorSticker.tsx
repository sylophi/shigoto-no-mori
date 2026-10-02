import { type CSSProperties, useState } from "react";
import { Heart, Star } from "lucide-react";
import { VillagerFace } from "@/components/shared/VillagerSays";
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
import { villagerCatchphrase } from "@/lib/villagerVoice";
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
// often they have come. Pressed, it flips over to their card.
// One who hasn't is an empty slot holding their silhouette. The rarer
// the character, the more the sticker carries (DESIGN.md, "Village
// life: rarity"): a regular villager's is plain, a special character's
// washes in their own color under their name plate, and a legend's is
// printed on their stationery with their face on a stamp.

// Every slot is one size, so the album lines up and a flip keeps its
// place, in a grid of as many as fit.
export const ALBUM_SLOT = "h-56";
export const ALBUM_GRID =
  "grid grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))] gap-4";

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
  // The one villager met most (bestFriendOf), whose sticker says so.
  bestFriend: boolean;
}) {
  // A face loads once its slot is scrolled near.
  const [ref, seen] = useSeen<HTMLDivElement>();
  const face = useVillagerFace(seen ? entry.slug : null);
  const delay: CSSProperties = {
    animationDelay: `${Math.min(index, STAGGERED) * 30}ms`,
  };
  return (
    <div ref={ref} className={ALBUM_SLOT}>
      {entry.visits === null ? (
        <EmptySlot entry={entry} face={face} style={delay} />
      ) : (
        <Sticker
          entry={entry}
          visits={entry.visits}
          face={face}
          bestFriend={bestFriend}
          style={delay}
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
  style,
}: {
  entry: AlbumEntry;
  visits: Visits;
  face: string | null;
  bestFriend: boolean;
  style: CSSProperties;
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
      aria-pressed={flipped}
      aria-label={`${profile.name}${bestFriend ? ", your best friend" : ""}, visited ${visitedTimes(visits.count)}`}
      onClick={flip}
      style={
        { ...style, "--tilt": `${stickerTilt(entry.slug)}deg` } as CSSProperties
      }
      className={cn(
        "visitor-pop group/sticker relative block size-full rounded-2xl text-left [perspective:900px] transition-[rotate,translate] duration-300 ease-out [rotate:var(--tilt)] focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
        "hover:-translate-y-1 hover:[rotate:0deg]",
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
  // "Smug cat", or whichever half the profile has.
  const kind = [profile.personality, profile.species?.toLowerCase()]
    .filter(Boolean)
    .join(" ");
  const about = kind.charAt(0).toUpperCase() + kind.slice(1);
  return (
    <span
      data-slot="visitor-sticker"
      style={villagerInk(color)}
      className={cn(FACE_SIDE, "bg-card px-3 pt-6 pb-4 shadow-sm")}
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
        <span className="absolute top-2.5 left-2.5 flex -rotate-6 items-center gap-1 rounded-md bg-rose-500 px-1.5 py-0.5 text-3xs font-bold text-white">
          <Heart aria-hidden className="size-2.5 fill-current" />
          Best friend
        </span>
      ) : (
        isNewVisitor(visits, today.getTime()) && (
          <span className="absolute top-2.5 left-2.5 -rotate-6 rounded-md bg-emerald-500 px-1.5 py-0.5 text-3xs font-bold text-white">
            New!
          </span>
        )
      )}
      <span className="relative flex size-20 items-center justify-center">
        {face !== null &&
          (rarity === "legendary" ? (
            <FaceStamp
              face={face}
              tint={paper.color}
              className="size-20 rotate-3 bg-popover p-1.5 transition-transform duration-300 group-hover/sticker:rotate-0"
            />
          ) : (
            <VillagerFace
              face={face}
              className="size-20 transition-transform duration-300 group-hover/sticker:scale-110 group-hover/sticker:-rotate-6"
            />
          ))}
      </span>
      <span className="relative mt-3 flex h-6 max-w-full items-center">
        {rarity === "rare" ? (
          <Nameplate className="truncate px-2.5 text-sm">
            {profile.name}
          </Nameplate>
        ) : (
          <span
            className={cn(
              "truncate text-base font-bold",
              rarity === "legendary" && paper.ink,
            )}
          >
            {profile.name}
          </span>
        )}
      </span>
      <span className="relative mt-0.5 h-4 max-w-full truncate text-2xs text-muted-foreground">
        {about}
      </span>
      <span className="relative mt-auto text-xs font-medium text-muted-foreground">
        Visited {visitedTimes(visits.count)}
      </span>
    </span>
  );
}

const BIRTHDAY = new Intl.DateTimeFormat(undefined, {
  month: "long",
  day: "numeric",
});

// "September 25", for a profile's MM-DD.
function birthdayOf(monthDay: string | undefined): string | null {
  const [month, day] = monthDay?.split("-").map(Number) ?? [];
  if (month === undefined || day === undefined) return null;
  return BIRTHDAY.format(new Date(2000, month - 1, day));
}

// The back of the card: what the guest book knows of them, written on
// lined paper.
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
  const birthday = birthdayOf(profile.birthday);
  // Key, label, value.
  const rows: [string, string, string][] = [
    ["visits", "Visits", String(visits.count)],
    ["first", "First came", visitDate(visits.first)],
    ["last", "Last came", formatRelativeTime(visits.last, now)],
  ];
  if (birthday !== null) rows.push(["birthday", "Birthday", birthday]);
  return (
    <span
      data-slot="visitor-sticker"
      className={cn(
        FACE_SIDE,
        "items-stretch bg-popover px-3.5 pt-3 pb-3 shadow-sm [transform:rotateY(180deg)]",
      )}
    >
      <span className="flex items-center gap-2">
        {face !== null && <VillagerFace face={face} className="size-8" />}
        <span className={cn("min-w-0 truncate text-sm font-bold", ink)}>
          {profile.name}
        </span>
      </span>
      <span className="mt-2 flex flex-col bg-[linear-gradient(transparent_calc(100%-1px),color-mix(in_oklab,var(--color-amber-400)_40%,transparent)_0)] bg-size-[100%_1.25rem] text-2xs leading-5">
        {rows.map(([key, label, value]) => (
          <span key={key} className="flex justify-between gap-2">
            <span className="truncate text-muted-foreground">{label}</span>
            <span className="shrink-0 font-medium">{value}</span>
          </span>
        ))}
      </span>
      {catchphrase !== null && (
        <span className="mt-auto truncate pt-1 text-center text-xs font-medium text-muted-foreground italic">
          “{catchphrase}”
        </span>
      )}
    </span>
  );
}

// A slot nobody has filled yet: their silhouette and a question mark,
// and for a regular villager what kind of animal they are, for a hint.
// A legend's slot wears a star, so the rarest finds are there to chase.
function EmptySlot({
  entry,
  face,
  style,
}: {
  entry: AlbumEntry;
  face: string | null;
  style: CSSProperties;
}) {
  const hint = entry.rarity === "common" ? entry.profile.species : undefined;
  return (
    <div
      data-slot="visitor-slot"
      style={style}
      aria-label="Hasn't visited yet"
      role="img"
      className="visitor-pop relative flex size-full flex-col items-center justify-center rounded-2xl bg-muted/60 px-3"
    >
      {entry.rarity === "legendary" && (
        <Star
          aria-hidden
          className="absolute top-3 right-3 size-4 fill-amber-400 text-amber-400"
        />
      )}
      <span className="flex size-20 items-center justify-center">
        {face !== null && (
          <VillagerFace
            face={face}
            tint={false}
            className="size-16 opacity-15 brightness-0 dark:opacity-25 dark:invert"
          />
        )}
      </span>
      <span className="mt-3 text-base font-black tracking-widest text-muted-foreground/60">
        ???
      </span>
      {hint && (
        <span className="mt-0.5 text-2xs text-muted-foreground/70">{hint}</span>
      )}
    </div>
  );
}
